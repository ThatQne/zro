/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        base:      "#0c0c0c",
        surface:   "#111111",
        overlay:   "#161616",
        hover:     "#1c1c1c",
        active:    "#222222",
        border:    "rgba(255,255,255,0.06)",
        accent:    "#4f80f5",
        "accent-dim": "#3a62c4",
        primary:   "#e4e4e4",
        secondary: "#6b6b6b",
        muted:     "#3a3a3a",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      fontSize: {
        "2xs": ["10px", "14px"],
        xs:    ["11px", "16px"],
        sm:    ["12px", "18px"],
        base:  ["13px", "20px"],
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "10px",
        xl: "14px",
      },
    },
  },
  plugins: [],
};
