import type { Config } from 'tailwindcss'

export default {
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Dark futuristic theme
        background: '#0B0F1A',
        foreground: '#FFFFFF',
        muted: 'rgba(255, 255, 255, 0.4)',
        'muted-foreground': 'rgba(255, 255, 255, 0.6)',
        
        // Primary gradient
        primary: '#A855F7',
        'primary-light': '#6366F1',
        'primary-cyan': '#22D3EE',
        
        // Surfaces
        card: 'rgba(255, 255, 255, 0.03)',
        'card-hover': 'rgba(255, 255, 255, 0.06)',
        border: 'rgba(255, 255, 255, 0.08)',
        'border-light': 'rgba(255, 255, 255, 0.12)',
      },
      backgroundColor: {
        'glass': 'rgba(255, 255, 255, 0.04)',
        'glass-hover': 'rgba(255, 255, 255, 0.06)',
      },
      backdropBlur: {
        'glass': '12px',
      },
      boxShadow: {
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.4), 0 0 40px rgba(99, 102, 241, 0.2)',
        'glow-purple-lg': '0 0 30px rgba(168, 85, 247, 0.6), 0 0 60px rgba(99, 102, 241, 0.3)',
        'glow-cyan': '0 0 20px rgba(34, 211, 238, 0.4)',
      },
      backgroundImage: {
        'gradient-brand': 'linear-gradient(90deg, #A855F7, #6366F1, #22D3EE)',
        'gradient-brand-hover': 'linear-gradient(90deg, #C084FC, #818CF8, #06B6D4)',
      },
      animation: {
        'glow-pulse': 'glow-pulse 3s ease-in-out infinite',
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': {
            boxShadow: '0 0 20px rgba(168, 85, 247, 0.4), 0 0 40px rgba(99, 102, 241, 0.2)',
          },
          '50%': {
            boxShadow: '0 0 30px rgba(168, 85, 247, 0.6), 0 0 60px rgba(99, 102, 241, 0.3)',
          },
        },
      },
      transitionDuration: {
        '250': '250ms',
        '300': '300ms',
      },
    },
  },
  plugins: [],
} satisfies Config
