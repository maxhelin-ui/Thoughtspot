import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        kpi_comparison_chart: resolve(__dirname, 'kpi_comparison_chart/index.html'),
        heatmap_chart: resolve(__dirname, 'heatmap_chart/index.html'),
        custom_bar_chart: resolve(__dirname, 'custom_bar_chart/index.html'),
        kpi_comparison_chart_dev: resolve(__dirname, 'kpi_comparison_chart_dev/index.html'),
        custom_column_chart: resolve(__dirname, 'custom_column_chart/index.html'),
        kpi_detailed: resolve(__dirname, 'kpi_detailed/index.html'),
        horizontal_dumbbell: resolve(__dirname, 'horizontal_dumbbell/index.html'),
        multi_axis_bar_chart: resolve(__dirname, 'multi_axis_bar_chart/index.html'),
        multi_y_axis_line: resolve(__dirname, 'multi_y_axis_line/index.html'),
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0', // Allows access from external devices
    port: 5173, // Ensure this matches your dev server port
    strictPort: true, // Ensures Vite does not pick a random port
    cors: {
      origin: '*', // Allow all origins
      methods: ['GET', 'POST'], // Adjust methods as needed
      allowedHeaders: ['Content-Type', 'Authorization'], // Allow required headers
    },
    proxy: {
      '/': {
        target: 'http://localhost:5173', // Proxy to your local server
        changeOrigin: true,
        secure: false, // Disable SSL verification if needed
        ws: true, // Enable WebSocket support
      },
    },
  },
});
