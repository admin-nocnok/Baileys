export type OfflineBatchLogger = {
	info: (obj: object, msg: string) => void
	warn: (obj: object, msg: string) => void
}

export type OfflineBatchRequesterDeps = {
	/** how many items to ask for per request */
	batchCount: number
	/** hard ceiling, so a server that never signals completion can't loop forever */
	maxDrain: number
	/** how long without an arriving item before assuming the batch is over and asking again */
	idleMs: number
	sendBatch: (count: number) => Promise<void>
	logger: OfflineBatchLogger
}

/**
 * Drives the offline queue drain.
 *
 * The server hands over only as many queued items as the client asked for, so asking a single time
 * stranded the rest of the queue server-side and live delivery never began -- instances reached
 * backlogs of days while appearing connected.
 *
 * Termination hangs off CB:ib,,offline and nothing else. An earlier revision stopped as soon as a
 * batch came back short, reading that as an empty queue; on the canary that halted three of four
 * instances at 7,500 and 15,900 of ~20,000 with the sockets still healthy, because the server also
 * paces delivery and a short batch means nothing on its own. So a short batch only arms the idle
 * timer, and the drain keeps asking until the server actually says it is done.
 */
export function makeOfflineBatchRequester({
	batchCount,
	maxDrain,
	idleMs,
	sendBatch,
	logger
}: OfflineBatchRequesterDeps) {
	let seenInBatch = 0
	let drained = 0
	let stopped = false
	let idleTimer: NodeJS.Timeout | undefined

	const clearIdle = () => {
		if (idleTimer) {
			clearTimeout(idleTimer)
			idleTimer = undefined
		}
	}

	const stop = (reason: string) => {
		if (stopped) {
			return
		}

		stopped = true
		clearIdle()
		logger.info({ drained, reason }, 'offline drain finished')
	}

	const armIdle = () => {
		clearIdle()
		if (stopped) {
			return
		}

		idleTimer = setTimeout(() => request('idle, no completion signal yet'), idleMs)
		idleTimer.unref?.()
	}

	const request = (reason: string) => {
		if (stopped) {
			return
		}

		if (drained >= maxDrain) {
			stop('drain ceiling reached')
			return
		}

		seenInBatch = 0
		logger.info({ drained, reason }, 'requesting offline batch')
		sendBatch(batchCount).catch(err => logger.warn({ err }, 'failed to request next offline batch'))
		armIdle()
	}

	return {
		/** the preview arrived and the first batch was already asked for elsewhere */
		onPreview: armIdle,
		onNode: () => {
			if (stopped) {
				return
			}

			seenInBatch++
			drained++

			if (seenInBatch >= batchCount) {
				request('batch consumed')
			} else {
				armIdle()
			}
		},
		/** CB:ib,,offline -- the only thing that actually ends the drain */
		onComplete: () => stop('server signalled completion'),
		stats: () => ({ drained, seenInBatch, stopped })
	}
}
