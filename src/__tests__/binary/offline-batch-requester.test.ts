import { jest } from '@jest/globals'
import { makeOfflineBatchRequester } from '../../Utils/offline-batch-requester'

const silentLogger = { info: () => {}, warn: () => {} }

const makeRequester = (over: Partial<{ batchCount: number; maxDrain: number; idleMs: number }> = {}) => {
	const asked: number[] = []
	const requester = makeOfflineBatchRequester({
		batchCount: 100,
		maxDrain: 50_000,
		idleMs: 10_000,
		sendBatch: async count => {
			asked.push(count)
		},
		logger: silentLogger,
		...over
	})

	return { asked, requester }
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

	it('stops at the ceiling rather than looping forever', () => {
		const { asked, requester } = makeRequester({ batchCount: 10, maxDrain: 30 })

		for (let i = 0; i < 500; i++) {
			requester.onNode()
		}

		expect(asked).toEqual([10, 10])
		expect(requester.stats().stopped).toBe(true)
	})
})
