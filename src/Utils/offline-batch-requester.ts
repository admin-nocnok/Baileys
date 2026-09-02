export type OfflineBatchLogger = {
	info: (obj: object, msg: string) => void
	warn: (obj: object, msg: string) => void
}

export type OfflineBatchRequesterDeps = {
	/** how many items to ask for per request */
	batchCount: number
	/** hard ceiling, so a server that always answers full batches can't loop forever */
	maxDrain: number
	sendBatch: (count: number) => Promise<void>
	logger: OfflineBatchLogger
}

/**
 * Drives the offline queue drain.
 *
 * The server hands over only as many queued items as the client asked for and then goes quiet: the
 * CB:ib,,offline completion signal never arrives (zero occurrences against 64 received previews
 * across 24h of fleet logs, 2026-09-02). Asking a single time stranded the rest of the queue
 * server-side and live delivery never began, which is how instances reached backlogs of days while
 * appearing connected. Counting arrivals is the only signal available, so the next batch is
 * requested once the previous one has been consumed.
 */
export function makeOfflineBatchRequester({ batchCount, maxDrain, sendBatch, logger }: OfflineBatchRequesterDeps) {
	let seenInBatch = 0
	let drained = 0
	let stopped = false

	const onNode = () => {
		if (stopped) {
			return
		}

		seenInBatch++
		drained++

		if (seenInBatch < batchCount) {
			return
		}

		seenInBatch = 0

		if (drained >= maxDrain) {
			stopped = true
			logger.warn({ drained, maxDrain }, 'offline drain ceiling reached, stopping')
			return
		}

		logger.info({ drained }, 'offline batch consumed, requesting next')
		sendBatch(batchCount).catch(err => logger.warn({ err }, 'failed to request next offline batch'))
	}

	return {
		onNode,
		stats: () => ({ drained, seenInBatch, stopped })
	}
}
