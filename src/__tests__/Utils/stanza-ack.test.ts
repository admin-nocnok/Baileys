import { buildAckStanza } from '../../Utils/stanza-ack'

const ME_PN = '5215551234567@s.whatsapp.net'
const ME_LID = '99887766554433@lid'

describe('buildAckStanza', () => {
	it('acks a PN-addressed message with the PN', () => {
		const stanza = buildAckStanza(
			{ tag: 'message', attrs: { id: 'A1', from: '5215557654321@s.whatsapp.net', type: 'text' } },
			undefined,
			ME_PN,
			ME_LID
		)

		expect(stanza.attrs.from).toBe(ME_PN)
		expect(stanza.attrs.to).toBe('5215557654321@s.whatsapp.net')
		expect(stanza.attrs.class).toBe('message')
	})

	it('acks a LID-addressed message with the LID', () => {
		const stanza = buildAckStanza(
			{ tag: 'message', attrs: { id: 'A2', from: '11223344556677@lid', type: 'text' } },
			undefined,
			ME_PN,
			ME_LID
		)

		expect(stanza.attrs.from).toBe(ME_LID)
	})

	it('honours an explicit addressing_mode over the sender suffix', () => {
		const stanza = buildAckStanza(
			{
				tag: 'message',
				attrs: {
					id: 'A3',
					from: '5215557654321@s.whatsapp.net',
					addressing_mode: 'lid',
					type: 'text'
				}
			},
			undefined,
			ME_PN,
			ME_LID
		)

		expect(stanza.attrs.from).toBe(ME_LID)
	})

	it('reads the addressing from the participant in a group stanza', () => {
		const stanza = buildAckStanza(
			{
				tag: 'message',
				attrs: { id: 'A4', from: '120363000000000000@g.us', participant: '11223344556677@lid', type: 'text' }
			},
			undefined,
			ME_PN,
			ME_LID
		)

		expect(stanza.attrs.from).toBe(ME_LID)
		expect(stanza.attrs.participant).toBe('11223344556677@lid')
	})

	// Falling back keeps the old behaviour for accounts that never got a LID.
	it('falls back to the PN when no LID is known', () => {
		const stanza = buildAckStanza(
			{ tag: 'message', attrs: { id: 'A5', from: '11223344556677@lid', type: 'text' } },
			undefined,
			ME_PN,
			undefined
		)

		expect(stanza.attrs.from).toBe(ME_PN)
	})

	it('never adds `from` to a non-message class', () => {
		const stanza = buildAckStanza(
			{ tag: 'receipt', attrs: { id: 'A6', from: '11223344556677@lid' } },
			undefined,
			ME_PN,
			ME_LID
		)

		expect(stanza.attrs.from).toBeUndefined()
		expect(stanza.attrs.class).toBe('receipt')
	})

	it('carries the error code through on a nack', () => {
		const stanza = buildAckStanza(
			{ tag: 'message', attrs: { id: 'A7', from: '11223344556677@lid', type: 'text' } },
			479,
			ME_PN,
			ME_LID
		)

		expect(stanza.attrs.error).toBe('479')
		expect(stanza.attrs.from).toBe(ME_LID)
	})
})
