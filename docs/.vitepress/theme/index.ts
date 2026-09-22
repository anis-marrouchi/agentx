import './brand.css'
import DefaultTheme from 'vitepress/theme'
import ScreenshotTour from './components/ScreenshotTour.vue'
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) { app.component('ScreenshotTour', ScreenshotTour) },
}
