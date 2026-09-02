import { jest } from '@jest/globals'
import { makeOfflineBatchRequester } from '../../Utils/offline-batch-requester'

const silentLogger = { info: () => {}, warn: () => {} }

const makeRequester = (
	over: Partial<{ batchCount: number; maxDrain: number; idleMs: number; maxPending: number }> = {}
) => {
	const asked: number[] = []
	// tests drive the handler's backlog by hand
	const backlog = { size: 0 }
	const requester = makeOfflineBatchRequester({
		batchCount: 100,
		maxDrain: 50_000,
		idleMs: 10_000,
		maxPending: 200,
		backpressureMs: 250,
		pendingWork: () => backlog.size,
		sendBatch: async count => {
			asked.push(count)
		},
		logger: silentLogger,
		...over
	})

	return { asked, requester, backlog }
}

describe('Offline batch requester', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())

	it('requests the next batch once the current one is consumed', () => {
		const { asked, requester } = makeRequester()

		for (let i = 0; i < 99; i++) {
			requester.onNode()
		}

		expect(asked).toHaveLength(0)

		requester.onNode()
		expect(asked).toEqual([100])
	})

	// The regression this exists for: an earlier revision treated a short batch as an empty queue
	// and stopped for good, stranding three of four canary instances mid-drain with live sockets.
	it('keeps going after a short batch instead of treating it as an empty queue', () => {
		const { asked, requester } = makeRequester()

		for (let i = 0; i < 40; i++) {
			requester.onNode()
		}

		expect(asked).toHaveLength(0)

		jest.advanceTimersByTime(10_000)
		expect(asked).toEqual([100])
		expect(requester.stats().stopped).toBe(false)

		jest.advanceTimersByTime(10_000)
		expect(asked).toEqual([100, 100])
	})

	it('ends the drain only when the server signals completion', () => {
		const { asked, requester } = makeRequester()

		requester.onPreview()
		requester.onComplete()

		jest.advanceTimersByTime(60_000)
		expect(asked).toHaveLength(0)
		expect(requester.stats().stopped).toBe(true)

		for (let i = 0; i < 200; i++) {
			requester.onNode()
		}

		expect(asked).toHaveLength(0)
	})

	it('reopens the drain when a new preview announces another queue', () => {
		const { asked, requester } = makeRequester()

		requester.onComplete()
		expect(requester.stats().stopped).toBe(true)

		requester.onPreview()
		expect(requester.stats().stopped).toBe(false)

		jest.advanceTimersByTime(10_000)
		expect(asked).toEqual([100])
	})

	// Arrival is not progress: the socket delivers far faster than items are handled, so pacing on
	// arrival pulled whole queues into memory. Tens of thousands of items per instance, against 250
	// instances on a worker, is how a node reaches 2.9 GB.
	it('stops asking while the handler is behind, and resumes once it catches up', () => {
		const { asked, requester, backlog } = makeRequester()

		backlog.size = 500

		for (let i = 0; i < 100; i++) {
			requester.onNode()
		}

		expect(asked).toHaveLength(0)

		jest.advanceTimersByTime(250)
		expect(asked).toHaveLength(0)

		jest.advanceTimersByTime(10_000)
		expect(asked).toHaveLength(0)

		backlog.size = 0
		jest.advanceTimersByTime(250)
		expect(asked).toEqual([100])
	})

	it('stops at the ceiling rather than looping forever', () => {
		const { asked, requester } = makeRequester({ batchCount: 10, maxDrain: 30 })

		for (let i = 0; i < 500; i++) {
			requester.onNode()
		}

		expect(asked).toEqual([10, 10])
		expect(requester.stats().stopped).toBe(true)
	})
})
