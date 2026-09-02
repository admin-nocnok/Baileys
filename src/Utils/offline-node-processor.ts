import type { BinaryNode } from '../WABinary'

export type MessageType = 'message' | 'call' | 'receipt' | 'notification'

type OfflineNode = {
	type: MessageType
	node: BinaryNode
}

export type OfflineNodeProcessorDeps = {
	isWsOpen: () => boolean
	onUnexpectedError: (error: Error, msg: string) => void
	yieldToEventLoop: () => Promise<void>
	/** called with however many nodes were still queued when the socket closed */
	onNodesPending?: (count: number) => void
}

/**
 * Creates a processor for offline stanza nodes that:
 * - Queues nodes for sequential processing
 * - Yields to the event loop periodically to avoid blocking
 * - Catches handler errors to prevent the processing loop from crashing
 */
export function makeOfflineNodeProcessor(
	nodeProcessorMap: Map<MessageType, (node: BinaryNode) => Promise<void>>,
	deps: OfflineNodeProcessorDeps,
	batchSize = 10
) {
	const nodes: OfflineNode[] = []
	let isProcessing = false

	const enqueue = (type: MessageType, node: BinaryNode) => {
		nodes.push({ type, node })

		if (isProcessing) {
			return
		}

		isProcessing = true

		const promise = async () => {
			let processedInBatch = 0

			while (nodes.length && deps.isWsOpen()) {
				const { type, node } = nodes.shift()!

				const nodeProcessor = nodeProcessorMap.get(type)

				if (!nodeProcessor) {
					deps.onUnexpectedError(new Error(`unknown offline node type: ${type}`), 'processing offline node')
					continue
				}

				await nodeProcessor(node).catch(err => deps.onUnexpectedError(err, `processing offline ${type}`))
				processedInBatch++

				// Yield to event loop after processing a batch
				// This prevents blocking the event loop for too long when there are many offline nodes
				if (processedInBatch >= batchSize) {
					processedInBatch = 0
					await deps.yieldToEventLoop()
				}
			}

			// The loop exits on a closed socket with whatever is still queued left in place, to be
			// picked up when the next enqueue restarts it. Nothing is lost, but until then those
			// nodes are unhandled and therefore unacked, so the server keeps offering them. Report
			// the depth: a queue that is deep here is the drain outrunning the handler.
			if (nodes.length) {
				deps.onNodesPending?.(nodes.length)
			}

			isProcessing = false
		}

		promise().catch(error => deps.onUnexpectedError(error, 'processing offline nodes'))
	}

	return {
		enqueue,
		/** how many nodes are waiting to be handled -- drives the drain's backpressure */
		pending: () => nodes.length
	}
}
