import { Boom } from '@hapi/boom'
import type { AuthenticationCreds, Contact, SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability, assertMeId, initAuthCreds } from '../../Utils/auth-utils'
import logger from '../../Utils/logger'

const credsWithMe = (me?: Partial<Contact>): AuthenticationCreds => ({
	...initAuthCreds(),
	me: me as Contact | undefined
})

describe('assertMeId', () => {
	it('returns me.id when authenticated', () => {
		const creds = credsWithMe({ id: '5511999999999@s.whatsapp.net' })
		expect(assertMeId(creds)).toBe('5511999999999@s.whatsapp.net')
	})

	it('throws Boom 401 when creds.me is undefined', () => {
		const creds = credsWithMe(undefined)
		try {
			assertMeId(creds)
			throw new Error('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(Boom)
			expect((err as Boom).output.statusCode).toBe(401)
			expect((err as Error).message).toMatch(/not authenticated/)
		}
	})

	it('throws Boom 401 when me has no id', () => {
		const creds = credsWithMe({})
		expect(() => assertMeId(creds)).toThrow(/not authenticated/)
	})

	it('throws Boom 401 when me.id is empty string', () => {
		const creds = credsWithMe({ id: '' })
		expect(() => assertMeId(creds)).toThrow(/not authenticated/)
	})
})

const memoryKeyStore = () => {
	const data: Record<string, Record<string, unknown>> = {}
	const store: SignalKeyStore = {
		get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) =>
			Object.fromEntries(ids.map(id => [id, data[type]?.[id]])) as { [id: string]: SignalDataTypeMap[T] },
		set: async set => {
			for (const [type, values] of Object.entries(set)) {
				data[type] = { ...data[type], ...values }
			}
		}
	}
	return { store, data }
}

const transactional = (store: SignalKeyStore) =>
	addTransactionCapability(store, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 0 })

// Node <= 22 stamps one symbol per enabled AsyncLocalStorage on every promise
const promiseSymbols = () => Object.getOwnPropertySymbols(Promise.resolve(1)).length

describe('addTransactionCapability', () => {
	it('keeps each key store on its own transaction, even nested inside another store transaction', async () => {
		const a = memoryKeyStore()
		const b = memoryKeyStore()
		const keysA = transactional(a.store)
		const keysB = transactional(b.store)

		await keysA.transaction(async () => {
			await keysA.set({ session: { 'a@s.whatsapp.net': Buffer.from('a') } })
			expect(keysB.isInTransaction()).toBe(false)

			await keysB.transaction(async () => {
				expect(keysA.isInTransaction()).toBe(true)
				expect(keysB.isInTransaction()).toBe(true)
				await keysB.set({ session: { 'b@s.whatsapp.net': Buffer.from('b') } })
			}, 'b')

			expect(b.data.session?.['b@s.whatsapp.net']).toBeDefined()
			expect(a.data.session).toBeUndefined()
			expect(keysB.isInTransaction()).toBe(false)
		}, 'a')

		expect(a.data.session?.['a@s.whatsapp.net']).toBeDefined()
		expect(b.data.session?.['a@s.whatsapp.net']).toBeUndefined()
	})

	it('does not register one AsyncLocalStorage per key store', async () => {
		await transactional(memoryKeyStore().store).transaction(async () => {}, 'warm-up')
		const before = promiseSymbols()
		for (let i = 0; i < 50; i++) {
			await transactional(memoryKeyStore().store).transaction(async () => {}, `store-${i}`)
		}

		expect(promiseSymbols()).toBe(before)
	})
})
