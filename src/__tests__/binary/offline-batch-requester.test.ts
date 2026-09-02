import { makeOfflineBatchRequester } from '../../Utils/offline-batch-requester'

const silentLogger = { info: () => {}, warn: () => {} }

describe('Offline batch requester', () => {
	it('requests the next batch only once the current one is consumed', () => {
		const asked: number[] = []
		const requester = makeOfflineBatchRequester({
			batchCount: 100,
			maxDrain: 50_000,
			sendBatch: async count => {
				asked.push(count)
			},
			logger: silentLogger
		})

		for (let i = 0; i < 99; i++) {
			requester.onNode()
		}

		expect(asked).toHaveLength(0)

		requester.onNode()
		expect(asked).toEqual([100])

		for (let i = 0; i < 100; i++) {
			requester.onNode()
		}

		expect(asked).toEqual([100, 100])
	})

	it('stops at the ceiling rather than looping forever', () => {
		const asked: number[] = []
		const requester = makeOfflineBatchRequester({
			batchCount: 10,
			maxDrain: 30,
			sendBatch: async count => {
				asked.push(count)
			},
			logger: silentLogger
		})

		for (let i = 0; i < 500; i++) {
			requester.onNode()
		}

		expect(asked).toEqual([10, 10])
		expect(requester.stats().stopped).toBe(true)
	})
})
