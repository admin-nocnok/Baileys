import type { BinaryNode } from '../WABinary'

/**
 * Builds an ACK stanza for a received node.
 * Pure function -- no I/O, no side effects.
 *
 * Mirrors WhatsApp Web's ACK construction:
 * - WAWebHandleMsgSendAck.sendAck / sendNack
 * - WAWebCreateNackFromStanza.createNackFromStanza
 */
export function buildAckStanza(node: BinaryNode, errorCode?: number, meId?: string, meLid?: string): BinaryNode {
	const { tag, attrs } = node
	const stanza: BinaryNode = {
		tag: 'ack',
		attrs: {
			id: attrs.id!,
			to: attrs.from!,
			class: tag
		}
	}

	if (errorCode) {
		stanza.attrs.error = errorCode.toString()
	}

	if (attrs.participant) {
		stanza.attrs.participant = attrs.participant
	}

	if (attrs.recipient) {
		stanza.attrs.recipient = attrs.recipient
	}

	// WA Web always includes type when present: `n.type || DROP_ATTR`
	if (attrs.type) {
		stanza.attrs.type = attrs.type
	}

	// WA Web WAWebHandleMsgSendAck.sendAck/sendNack always include `from` for message-class ACKs.
	// The identity has to match how the stanza addressed us -- the same rule the socket already
	// applies elsewhere (`from: isLid ? me.lid : me.id` when replying to a LID chat); this path
	// was the one still hardcoding the PN. Addressing is detected the same way
	// extractAddressingContext does it, inlined to keep this function pure.
	//
	// This was originally written believing it caused the
	// <stream:error><ack class='message' .../></stream:error> teardowns. Measured against a canary
	// running this patch, it does not: those drops continued at the same per-instance rate as
	// unpatched nodes, on a ~3000 s metronome. They are a separate, still-undiagnosed problem --
	// and note that neither the "ack" nor the 500 in that error comes from the server, they are
	// getErrorCodeFromStreamError falling back to the first child's tag and to badSession. This
	// change stands on addressing consistency alone.
	if (tag === 'message' && meId) {
		const sender = attrs.participant || attrs.from
		const isLidAddressed = attrs.addressing_mode
			? attrs.addressing_mode === 'lid'
			: Boolean(sender?.endsWith('lid'))
		stanza.attrs.from = isLidAddressed && meLid ? meLid : meId
	}

	return stanza
}
