<script setup lang="ts">
import { computed } from 'vue'
import { useHead } from '@unhead/vue'

const title = computed(() => 'hello')
useHead({ title })
</script>
