/*
 * Runs in the page's MAIN world at document_start.
 *
 * Once the content script has routed a media element through Web Audio it marks
 * the element with data-lmeter="on". From then on the element's native volume is
 * pinned to 1 / unmuted so the meter always sees the unattenuated signal, and the
 * player's volume and mute are kept here as "virtual" values that the content
 * script applies with a GainNode *after* the meter tap.
 */
(() => {
  'use strict';
  const proto = HTMLMediaElement.prototype;
  if (proto.__lmeterHooked) return;

  const volumeDesc = Object.getOwnPropertyDescriptor(proto, 'volume');
  const mutedDesc = Object.getOwnPropertyDescriptor(proto, 'muted');
  if (!volumeDesc || !mutedDesc) return;

  // Captured up front so later page patches cannot interfere.
  const getAttr = Element.prototype.getAttribute;
  const setAttr = Element.prototype.setAttribute;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const ATTR = 'data-lmeter';
  const ATTR_VOL = 'data-lmeter-vol';
  const ATTR_MUTED = 'data-lmeter-muted';

  const isOn = (el) => getAttr.call(el, ATTR) === 'on';

  // Native volumechange is fired from a queued task; mirror that.
  const fireVolumeChange = (el) => {
    setTimeout(() => dispatch.call(el, new Event('volumechange')), 0);
  };

  Object.defineProperty(proto, '__lmeterHooked', { value: true });

  Object.defineProperty(proto, 'volume', {
    configurable: true,
    enumerable: volumeDesc.enumerable,
    get() {
      if (isOn(this)) {
        const v = parseFloat(getAttr.call(this, ATTR_VOL));
        return Number.isFinite(v) ? v : 1;
      }
      return volumeDesc.get.call(this);
    },
    set(value) {
      if (!isOn(this)) {
        volumeDesc.set.call(this, value);
        return;
      }
      const v = Number(value);
      if (!Number.isFinite(v)) {
        throw new TypeError("Failed to set the 'volume' property on 'HTMLMediaElement': The provided double value is non-finite.");
      }
      if (v < 0 || v > 1) {
        throw new DOMException(
          `Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${v}) is outside the range [0, 1].`,
          'IndexSizeError'
        );
      }
      if (parseFloat(getAttr.call(this, ATTR_VOL)) === v) return;
      setAttr.call(this, ATTR_VOL, String(v));
      fireVolumeChange(this);
    },
  });

  Object.defineProperty(proto, 'muted', {
    configurable: true,
    enumerable: mutedDesc.enumerable,
    get() {
      if (isOn(this)) return getAttr.call(this, ATTR_MUTED) === '1';
      return mutedDesc.get.call(this);
    },
    set(value) {
      if (!isOn(this)) {
        mutedDesc.set.call(this, value);
        return;
      }
      const m = value ? '1' : '0';
      if (getAttr.call(this, ATTR_MUTED) === m) return;
      setAttr.call(this, ATTR_MUTED, m);
      fireVolumeChange(this);
    },
  });
})();
