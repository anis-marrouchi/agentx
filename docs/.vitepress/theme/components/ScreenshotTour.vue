<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { withBase } from 'vitepress'
type Step = { title: string; text: string; image: string; alt: string; box: number[] }
const props = defineProps<{ title: string; steps: Step[] }>()
const index = ref(0)
const playing = ref(false)
const zoomed = ref(true)
const scene = computed(() => {
  const [x, y, w, h] = step.value.box
  const scale = zoomed.value ? Math.min(3, 70 / w, 65 / h) : 1
  const clamp = (v: number) => Math.max(100 - 100 * scale, Math.min(0, v))
  return { "--tour-inverse": String(1 / scale), transform: `translate(${clamp(50 - (x + w / 2) * scale)}%, ${clamp(50 - (y + h / 2) * scale)}%) scale(${scale})` }
})
const step = computed(() => props.steps[index.value])
const focus = computed(() => ({ left: `${step.value.box[0]}%`, top: `${step.value.box[1]}%`, width: `${step.value.box[2]}%`, height: `${step.value.box[3]}%` }))
let timer: ReturnType<typeof setInterval> | undefined
function pause() { clearInterval(timer); timer = undefined; playing.value = false }
function choose(i: number) { pause(); index.value = i }
function play() {
  if (playing.value) return pause()
  if (index.value === props.steps.length - 1) index.value = 0
  playing.value = true
  timer = setInterval(() => {
    if (index.value < props.steps.length - 1) index.value++
    else pause()
  }, 6500)
}
onBeforeUnmount(pause)
</script>

<template>
  <section class="screenshot-tour" :aria-label="title" @keydown.esc="pause">
    <header><span class="tour-eyebrow">GUIDED WALKTHROUGH</span><strong>{{ title }}</strong><span>{{ index + 1 }} / {{ steps.length }}</span></header>
    <div class="tour-frame">
      <div class="tour-scene" :style="scene">
      <img :src="withBase(step.image)" :alt="step.alt" width="2880" height="1800">
      <div class="tour-focus" :style="focus" aria-hidden="true"><span>{{ index + 1 }}</span></div>
      </div>
    </div>
    <div class="tour-caption" aria-live="polite" aria-atomic="true"><strong>{{ step.title }}</strong><p>{{ step.text }}</p></div>
    <nav aria-label="Walkthrough controls">
      <button type="button" :disabled="index === 0" @click="choose(index - 1)">← Previous</button>
      <button type="button" :aria-pressed="playing" @click="play">{{ playing ? 'Pause' : 'Play tour' }}</button>
      <button type="button" :disabled="index === steps.length - 1" @click="choose(index + 1)">Next →</button>
    </nav>
    <div class="tour-view"><button type="button" :aria-pressed="zoomed" @click="zoomed = !zoomed">{{ zoomed ? "Show whole screen" : "Zoom to highlight" }}</button></div>
    <div class="tour-steps"><button v-for="(s, i) in steps" :key="s.title" type="button" :aria-current="i === index ? 'step' : undefined" @click="choose(i)">{{ i + 1 }}. {{ s.title }}</button></div>
    <p class="tour-source">Real screenshots from the scripted AgentX demo. Highlights are annotations; the controls shown inside the images are not interactive.</p>
  </section>
</template>

<style scoped>
.screenshot-tour{margin:28px 0;border:1px solid var(--vp-c-divider);border-radius:16px;overflow:hidden;background:var(--vp-c-bg-soft)}
header{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:16px 20px}header strong{flex:1}header>span:last-child{font-variant-numeric:tabular-nums}.tour-eyebrow{font-size:10px;font-weight:700;letter-spacing:.12em;color:var(--vp-c-brand-1);width:100%}
.tour-frame{position:relative;overflow:hidden;background:#eef0f4;aspect-ratio:16/10}.tour-scene{position:relative;transform-origin:0 0;transition:transform .65s ease}.tour-view{padding:0 20px}.tour-view button{font-size:12px;color:var(--vp-c-brand-1);text-decoration:underline}.tour-frame img{display:block;width:100%;height:auto;margin:0}.tour-focus{position:absolute;border:2px solid #7656ef;border-radius:7px;box-shadow:0 0 0 999px #17203955;transition:left .5s ease,top .5s ease,width .5s ease,height .5s ease;pointer-events:none}.tour-focus span{transform:scale(var(--tour-inverse,1));position:absolute;top:-12px;left:-12px;border:2px solid white;border-radius:50%;background:#5939c9;color:white;width:26px;height:26px;display:grid;place-items:center;font-size:12px;font-weight:700}
.tour-caption{padding:20px 20px 4px;min-height:130px}.tour-caption strong{font-size:18px}.tour-caption p{margin:8px 0;font-size:15px;line-height:1.7}nav{display:flex;gap:8px;padding:12px 20px}nav button{border:1px solid var(--vp-c-divider);border-radius:8px;padding:8px 12px;background:var(--vp-c-bg);font-size:13px}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:3px solid var(--vp-c-brand-1);outline-offset:2px}.tour-steps{display:flex;gap:6px;flex-wrap:wrap;padding:8px 20px}.tour-steps button{font-size:12px;padding:6px 8px;border-radius:6px}.tour-steps [aria-current]{background:var(--vp-c-brand-soft);color:var(--vp-c-brand-1)}.tour-source{font-size:12px!important;color:var(--vp-c-text-2);padding:0 20px 16px;margin:8px 0 0!important;line-height:1.5!important}@media(prefers-reduced-motion:reduce){.tour-focus,.tour-scene{transition:none}}@media(max-width:480px){nav{padding:10px;gap:5px}nav button{flex:1;padding:8px 5px}.tour-caption{padding:16px;min-height:175px}}
</style>
