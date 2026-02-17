Reveal.initialize({
  hash: true,
  width: 1280,
  height: 720,
  margin: 0.04,
  center: true,
  transition: 'slide',
  transitionSpeed: 'default',
  slideNumber: 'c/t',
  showSlideNumber: 'all',
  controls: true,
  progress: true,
  history: true,
  plugins: [RevealNotes],
}).then(() => {
  // Multiplex audience mode: only if server injected MULTIPLEX_ID (no secret)
  const socketId = window.MULTIPLEX_ID;
  const secret = window.MULTIPLEX_SECRET;
  if (!socketId || secret) return; // skip if no ID, or if this is a speaker page

  // Load socket.io client and follow the speaker
  const script = document.createElement('script');
  script.src = '/socket.io/socket.io.js';
  script.onload = () => {
    const socket = io();
    socket.on(socketId, (data) => {
      Reveal.slide(data.indexh, data.indexv, data.indexf);
    });
  };
  document.head.appendChild(script);
});
