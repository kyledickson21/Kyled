/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Overrides Tailwind's stock `teal` scale with Kyle's brand color. Sampled the
        // REsimpli logo directly (#008080), then nudged darker and bluer per feedback
        // ("still looks too green") — hue shifted from 180° to 195°, lightness trimmed
        // slightly — generated at the same hue across the scale so every existing
        // `teal-NNN` class across the app (hundreds of them) repaints without touching
        // the JSX.
        teal: {
          50: '#F0FAFD', 100: '#CCEFFB', 200: '#99DFF6', 300: '#5EC7EA',
          400: '#2DAAD4', 500: '#148FB8', 600: '#0D7294', 700: '#0F5C76',
          800: '#114B5E', 900: '#133F4E', 950: '#04242F',
        },
      },
    },
  },
  plugins: [],
};
