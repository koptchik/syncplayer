/* global customElements, HTMLElement, performance, CustomEvent, setTimeout, setInterval */
// A deterministic component exercising the opaque sandbox and relay (no external requests).
customElements.define(
  'video-player',
  class extends HTMLElement {
    connectedCallback() {
      let time = 0,
        playing = false,
        at = performance.now();
      const emit = (name, detail = {}) => this.dispatchEvent(new CustomEvent(name, { detail }));
      const advance = () => {
        if (playing) time += (performance.now() - at) / 1000;
        at = performance.now();
      };
      this.messageBridge = {
        send: (method, payload) => {
          advance();
          if (method === 'play') {
            playing = true;
            emit('playStart');
            emit('changeState', { state: 'playing' });
          }
          if (method === 'pause') {
            playing = false;
            emit('changeState', { state: 'paused' });
          }
          if (method === 'seekTime') {
            time = payload.position;
            emit('currentTime', { time });
          }
        },
      };
      this.innerHTML = '<div style="color:white">Test CVH</div>';
      setTimeout(() => {
        emit('ready');
        emit('durationChange', { duration: 300 });
      }, 50);
      setInterval(() => {
        advance();
        emit('currentTime', { time });
      }, 300);
    }
  },
);
