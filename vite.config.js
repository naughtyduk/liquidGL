import { defineConfig } from 'vite';

export default defineConfig({
  // Base public path
  base: './',
  
  // Server configuration
  server: {
    port: 3000,
    open: true, // Automatically open browser
    cors: true, // Enable CORS
  },
  
  // Build configuration
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    // Optimize chunks
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor': ['gsap'],
        }
      }
    }
  },
  
  // Asset handling
  assetsInclude: ['**/*.mp4', '**/*.webp', '**/*.svg'],
});
