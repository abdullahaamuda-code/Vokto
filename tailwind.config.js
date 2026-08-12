/** @type {import('tailwindcss').Config} */
export default {
  content: ['src/renderer/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07070b',
          900: '#0b0b12',
          850: '#101018',
          800: '#15151f',
          700: '#1e1e2c',
          600: '#2a2a3c',
          400: '#525270',
          300: '#8a8aa3',
          200: '#b8b8cc',
          100: '#e4e4ef',
        },
        glow: {
          DEFAULT: '#e8b04a',
          soft: '#f5cf85',
          hot: '#c78f1e',
        },
        mint: '#34e0b4',
        warn: '#ffb454',
        danger: '#ff5c74',
      },
      fontFamily: {
        sans: ['"Sora"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
