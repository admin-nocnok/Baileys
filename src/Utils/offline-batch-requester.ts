/** 30 x a 10 s idle is five minutes of silence; a healthy drain closes in seconds */
const DEFAULT_MAX_IDLE_RETRIES = 30

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
	/** consecutive idle retries that bring nothing in before giving up on a silent server */
	maxIdleRetries?: number
	/** stop asking while this many items are still waiting to be handled */
	maxPending: number
	/** how long to wait before re-checking whether the handler caught up */
	backpressureMs: number
	/** items received but not yet handled */
	pendingWork: () => number
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
	maxIdleRetries = DEFAULT_MAX_IDLE_RETRIES,
	maxPending,
	backpressureMs,
	pendingWork,
	sendBatch,
	logger
}: OfflineBatchRequesterDeps) {
	let seenInBatch = 0
	let drained = 0
	let stopped = false
	let idleRetries = 0
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

		// A live socket whose server answers neither with items nor with CB:ib,,offline is invisible
		// to every other exit: sendBatch resolves so the catch never runs, and maxDrain only moves in
		// onNode(). Before this, one such session asked every idleMs for 55 minutes and others for
		// over four hours, until a reconnect rebuilt the socket. The streak resets in onNode(), so
		// only a server that sends nothing at all trips this.
		idleTimer = setTimeout(() => {
			if (++idleRetries >= maxIdleRetries) {
				stop('idle ceiling reached, server never answered')
				return
			}

			request('idle, no completion signal yet')
		}, idleMs)
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

		// Arrival is not progress: items land in an in-memory queue and are handled one at a time,
		// decrypt and persist included, which is far slower than the socket delivers them. Pacing
		// on arrival pulled entire queues into memory -- tens of thousands of items per instance,
		// against 250 instances on a worker. Ask for more only once the handler has caught up.
		if (pendingWork() >= maxPending) {
			clearIdle()
			idleTimer = setTimeout(() => request('handler caught up'), backpressureMs)
			idleTimer.unref?.()
			return
		}

		seenInBatch = 0
		logger.info({ drained, reason }, 'requesting offline batch')
		// A send that rejects means the socket is gone, and a gone socket has nothing left to
		// drain. Logging and re-arming instead kept the timer firing against a dead socket every
		// idleMs until the container recycled -- worker-04 did it for over three hours on
		// 2026-09-10 after an instance migrated away. The maxDrain ceiling does not cover this:
		// `drained` only moves in onNode(), so with nothing arriving it stays frozen and the
		// ceiling is never reached. stop() clears the timer armIdle() is about to set, since this
		// catch runs a microtask later.
		sendBatch(batchCount).catch(err => {
			logger.warn({ err }, 'failed to request next offline batch')
			stop('send failed')
		})
		armIdle()
	}

	return {
		/** the preview arrived and the first batch was already asked for elsewhere */
		onPreview: () => {
			// A fresh preview announces another queue, so a drain that already reached its
			// completion must not stay closed -- otherwise the second queue sits there until the
			// session is recycled, which is the same silent halt this whole thing exists to avoid.
			// `drained` stays cumulative on purpose, so the ceiling still bounds the session.
			stopped = false
			seenInBatch = 0
			idleRetries = 0
			armIdle()
		},
		onNode: () => {
			if (stopped) {
				return
			}

			seenInBatch++
			drained++
			// an arrival is the server answering, whatever the pace
			idleRetries = 0

			if (seenInBatch >= batchCount) {
				request('batch consumed')
			} else {
				armIdle()
			}
		},
		/** CB:ib,,offline -- the only thing that actually ends the drain */
		onComplete: () => stop('server signalled completion'),
		stats: () => ({ drained, seenInBatch, stopped, idleRetries })
	}
}
