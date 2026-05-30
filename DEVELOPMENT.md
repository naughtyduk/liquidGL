# liquidGL - Development Setup

## 🚀 Quick Start

### Install Dependencies
```bash
npm install
```

### Start Development Server
```bash
npm run dev
```

This will start the Vite dev server at **http://localhost:3000** and automatically open your browser.

### Build for Production
```bash
npm run build
```

This creates an optimized production build in the `dist` folder.

### Preview Production Build
```bash
npm run preview
```

## 📁 Project Structure

```
liquidGL/
├── index.html              # Main HTML file
├── css/
│   └── styles.css         # All styles
├── scripts/
│   ├── navigation.js      # Navigation module
│   ├── preloader.js       # Preloader module
│   ├── liquidgl-init.js   # LiquidGL initialization
│   ├── video-player.js    # Video player module
│   ├── html2canvas.min.js # HTML2Canvas library
│   └── liquidGL.js        # LiquidGL library
├── assets/                # Images, videos, fonts
├── demos/                 # Demo pages
├── package.json           # Project dependencies
└── vite.config.js         # Vite configuration
```

## ✨ Features

- ⚡ **Lightning Fast** - Vite dev server with instant HMR
- 🔥 **Hot Module Replacement** - Changes appear instantly
- 🚫 **No CORS Issues** - Proper dev server handling
- 📦 **Optimized Builds** - Production-ready output
- 🎯 **Modern Tooling** - Industry-standard workflow

## 🛠️ Development

The Vite dev server will:
- Auto-reload on file changes
- Handle CORS properly (no more WebGL errors!)
- Serve files with proper MIME types
- Enable source maps for debugging

## 📝 Notes

- The dev server runs on port 3000 by default
- Browser will open automatically when you run `npm run dev`
- All paths are configured to work with Vite's asset handling
