import { expect } from 'chai';
import { buildMessageEvent, buildReactionEvent, buildReceiptEvent } from '../../handlers/matrix-events'; // Adjust path as needed
import { ArcEvent } from '../../types/arc-event'; // Adjust path

describe('ArcEvent Mapping Tests', () => {
  it('should map enriched message to new ArcEvent structure', () => {
    const enriched = {
      serialId: '$testEvent:server',
      from: '@sender:server',
      to: '!testRoom:server',
      body: 'test message',
      timestamp: 1234567890000, // ms
      id: { _serialized: '$testEvent:server' }
    };
    const event: ArcEvent = buildMessageEvent(enriched as any);
    expect(event.source).to.equal('messenger');
    expect(event.arcUserId).to.equal('testarcUserId'); // Assuming sessionId returns 'testarcUserId' in test env
    expect(event.eventId).to.equal('$testEvent:server');
    expect(event.roomId).to.equal('!testRoom:server');
    expect(event.senderId).to.equal('@sender:server');
    expect(event.timestamp).to.be.closeTo(1234567890000, 1); // ms
    expect(event.type).to.equal('message');
    expect(event.platform).to.equal('matrix');
    expect(event.content.body).to.equal('test message');
    expect(event.content.event_id).to.equal('$testEvent:server');
    expect(event.content.event_ts).to.be.closeTo(1234567890, 1); // seconds
    expect(event.content.id).to.deep.equal({ _serialized: '$testEvent:server' });
    expect(event.content.serialId).to.equal('$testEvent:server');
    expect(event.v).to.equal(1);
    expect(event.ackPolicy).to.equal('at-least-once');
    expect(event.ttlMs).to.equal(600000);
  });

  it('should map enriched reaction to new ArcEvent structure', () => {
    const enrichedMsg = { to: '!testRoom:server', from: '@sender:server', timestamp: 1234567890000 };
    const reaction = { id: { _serialized: '$reaction:server' }, msgId: { _serialized: '$target:server' }, reaction: '👍', timestamp: 1234567891000 };
    const event: ArcEvent = buildReactionEvent(reaction as any, enrichedMsg as any);
    expect(event.source).to.equal('messenger');
    expect(event.arcUserId).to.equal('testarcUserId');
    expect(event.eventId).to.equal('$reaction:server');
    expect(event.roomId).to.equal('!testRoom:server');
    expect(event.senderId).to.equal('@sender:server');
    expect(event.timestamp).to.be.closeTo(1234567891000, 1); // ms
    expect(event.type).to.equal('reaction');
    expect(event.content.body).to.equal('👍');
    expect(event.content.event_id).to.equal('$reaction:server');
    expect(event.content.event_ts).to.be.closeTo(1234567891, 1);
    expect(event.content.emoji).to.equal('👍');
    expect(event.content.targetMessageId).to.equal('$target:server');
    expect(event.relatesTo.eventId).to.equal('$target:server');
    expect(event.relatesTo.relationType).to.equal('annotation');
    expect(event.platform).to.equal('matrix');
    expect(event.v).to.equal(1);
    expect(event.ackPolicy).to.equal('at-least-once');
    expect(event.ttlMs).to.equal(600000);
  });

  it('should map enriched receipt to new ArcEvent structure', () => {
    const enrichedMsg = { to: '!testRoom:server', from: '@sender:server', timestamp: 1234567890000 };
    const event: ArcEvent = buildReceiptEvent('$target:server', enrichedMsg as any, 'read', 1234567891000);
    expect(event.source).to.equal('messenger');
    expect(event.arcUserId).to.equal('testarcUserId');
    expect(event.eventId).to.equal('$target:server');
    expect(event.roomId).to.equal('!testRoom:server');
    expect(event.senderId).to.equal('@sender:server');
    expect(event.timestamp).to.be.closeTo(1234567891000, 1); // ms
    expect(event.type).to.equal('receipt');
    expect(event.content.ack).to.equal('read');
    expect(event.content.targetMessageId).to.equal('$target:server');
    expect(event.relatesTo.eventId).to.equal('$target:server');
    expect(event.platform).to.equal('matrix');
    expect(event.v).to.equal(1);
    expect(event.ackPolicy).to.equal('at-least-once');
    expect(event.ttlMs).to.equal(600000);
  });
});
