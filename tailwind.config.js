module.exports = {
  darkMode: 'class',
  content: ['./src/index.html', './src/transcribe.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        studio: { 950: '#09090b', 900: '#101014', 850: '#16161c', 800: '#1e1e26', 700: '#2a2a35' },
      },
      boxShadow: {
        'neon-emerald': '0 0 25px -5px rgba(16, 185, 129, 0.5)',
        'neon-amber': '0 0 25px -5px rgba(245, 158, 11, 0.45)',
        'neon-rose': '0 0 25px -5px rgba(244, 63, 94, 0.45)',
        'pedal': '0 25px 50px -12px rgba(0, 0, 0, 0.85), inset 0 1px 0 0 rgba(255, 255, 255, 0.08)',
      },
    },
  },
};
