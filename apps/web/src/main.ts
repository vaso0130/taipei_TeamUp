// Theme class first, before Vue mounts, so a stored dark choice does not flash light.
import './theme-boot.js'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router.js'
import './assets/main.css'

createApp(App).use(createPinia()).use(router).mount('#app')
