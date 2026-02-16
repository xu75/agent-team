

// src/engine/run-event.js

/**
 * RunEvent schema (v0.1)
 *
 * {
 *   type: string,         // event type, e.g. run.started / run.stdout.line / run.completed
 *   ts: number,           // timestamp in epoch milliseconds
 *   data: object,         // payload specific to the event
 *   meta: {               // metadata for tracing and correlation
 *     run_id?: string,
 *     provider?: string,
 *     pid?: number
 *   }
 * }
 */

function nowMs() {
  return Date.now();
}

/**
 * Create a normalized RunEvent.
 *
 * @param {string} type - Event type
 * @param {object} data - Event payload
 * @param {object} meta - Event metadata
 * @returns {object} RunEvent
 */
function makeEvent(type, data = {}, meta = {}) {
  return {
    type,
    ts: nowMs(),
    data,
    meta,
  };
}

module.exports = { makeEvent };