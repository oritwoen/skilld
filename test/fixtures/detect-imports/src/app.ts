import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import something from './local-module'

export const x = ref(useRoute())
