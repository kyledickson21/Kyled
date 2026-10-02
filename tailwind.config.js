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
        // Overrides Tailwind's stock `teal` scale with Kyle's REsimpli brand color
        // (#008080, sampled directly from their logo) at the 700 position, with the
        // rest of the scale generated at the same hue so every existing `teal-NNN`
        // class across the app (hundreds of them) repaints without touching the JSX.
        teal: {
          50: '#F0FDFD', 100: '#CCFBFB', 200: '#99F6F6', 300: '#5EEAEA',
          400: '#2DD4D4', 500: '#14B8B8', 600: '#0D9494', 700: '#008080',
          800: '#115E5E', 900: '#134E4E', 950: '#042F2F',
        },
      },
    },
  },
  plugins: [],
};
