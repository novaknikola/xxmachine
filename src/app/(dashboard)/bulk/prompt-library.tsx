'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Plus } from 'lucide-react'

export const PROMPT_THEMES = [
  {
    label: 'Confident',
    prompts: [
      'Standing with feet shoulder-width apart, hands on hips, direct eye contact, strong posture.',
      'Arms crossed, slight smirk, leaning against wall, commanding presence.',
      'Walking towards camera, chin up, shoulders back, purposeful stride.',
      'Sitting on desk edge, one leg dangling, direct gaze, relaxed power pose.',
      'Standing with one hand in pocket, other hand gesturing, confident expression.',
      'Looking down at camera from elevated position, arms relaxed at sides.',
      'Back straight, hands clasped in front, slight head tilt, composed expression.',
      'Standing sideways, turning head to camera, sharp jawline visible, strong profile.',
      'Leaning forward slightly towards camera, hands on knees, intense eye contact.',
      'One hand raised to chin in thinking pose, eyes locked on camera.',
      'Standing with jacket draped over shoulder, one hand holding it, cool confidence.',
      'Sitting in chair backwards, arms resting on back of chair, direct stare.',
      'Arms stretched wide on top of sofa, legs crossed, owning the space.',
      'Walking away, then looking back over shoulder with confident smirk.',
      'Standing in doorway, hand on frame, filling the space with presence.',
      'One foot on step above, leaning on raised knee, looking down at camera.',
      'Hands behind back, standing tall, slight smile, composed and assured.',
      'Leaning against column, arms loosely crossed, relaxed but powerful stance.',
      'Sitting cross-legged on floor, back straight, hands on knees, calm authority.',
      'Standing in profile, slowly turning face towards camera, sharp and deliberate.',
    ],
  },
  {
    label: 'Flirty / Playful',
    prompts: [
      'Hand running through hair, head tilted back slightly, playful laugh.',
      'Peeking around corner, one eye visible, mischievous smile.',
      'Sitting on chair, legs swinging, hands gripping seat edge, big smile.',
      'Blowing a kiss towards camera, eyes half-closed, playful expression.',
      'Finger on lips in a shushing gesture, eyes wide and teasing.',
      'Twirling in place, skirt or hair spinning, caught mid-spin looking at camera.',
      'Winking at camera, head slightly tilted, bright smile.',
      'Lying on stomach on bed, kicking feet up, chin in hands, flirty gaze.',
      'Sitting on counter, legs dangling, leaning forward conspiratorially.',
      'Hands framing face, elbows on table, big playful grin.',
      'Looking up from under lashes, slight smile, soft expression.',
      'Playfully pulling collar or sleeve, glancing sideways at camera.',
      'Sitting cross-legged, leaning forward, excited expression, hands on cheeks.',
      'Standing on tiptoes, hands clasped behind back, coy smile.',
      'Catching falling hat, laughing, candid natural moment.',
      'Biting lower lip gently, direct eye contact, amused expression.',
      'Peeking over top of sunglasses, eyebrow raised, flirtatious look.',
      'Spinning around with arms out, caught mid-laugh, carefree moment.',
      'Sitting sideways on chair, legs over armrest, idly playing with hair.',
      'Finger-gunning at camera, tongue out, playful and irreverent.',
    ],
  },
  {
    label: 'Movement / Dynamic',
    prompts: [
      'Mid-stride walk towards camera, hair caught in motion, natural movement.',
      'Spinning around, hair fanning out in circle, caught at peak spin.',
      'Jumping mid-air, arms out, genuine joy, frozen in motion.',
      'Running fingers through hair with both hands, head tilted back, eyes closed.',
      'Turning sharply to face camera, coat or jacket swinging wide.',
      'Caught mid-laugh, head thrown back, completely natural candid moment.',
      'Walking away from camera, then sharp look back over shoulder.',
      'Stepping off curb, caught mid-step, relaxed urban movement.',
      'Shaking hair out, motion blur on ends, face sharp and clear.',
      'Arms thrown wide open, spinning, caught from low angle.',
      'Striding confidently past camera, caught in sharp profile.',
      'Reaching upward for something above, body elongated, dynamic stretch.',
      'Caught in moment of sitting down, halfway between standing and seated.',
      'Pushing hair back from face with one hand, wind effect, eyes open.',
      'Mid-turn, fabric or hair in motion, three-quarter angle to camera.',
      'Stepping up onto surface, weight shifting forward, dynamic energy.',
      'Caught looking down at phone then glancing up, natural transition.',
      'Walking through doorway, caught mid-step, natural entrance.',
      'Tossing object in air, eyes tracking it, body slightly twisted.',
      'Quick turn catching camera by surprise, genuine spontaneous expression.',
    ],
  },
  {
    label: 'Close-up / Detail',
    prompts: [
      'Extreme close-up of eyes only, sharp focus, catching light reflection.',
      'Close-up of profile, jawline sharp, ear and neck visible, minimal crop.',
      'Hands framing face from below, fingers spread, face peeking through.',
      'Tight crop on mouth and nose, neutral expression, texture focus.',
      'One eye visible through gap between fingers, mysterious framing.',
      'Close-up of collarbone and neck area, chin barely in frame above.',
      'Hands clasped together under chin, face soft above, detail on hands.',
      'Side profile of ear, jaw, and neck, hair tucked back, clean lines.',
      'Close-up of forehead and eyes only, eyebrows expressive, sharp focus.',
      'Tight shot of lips mid-speech or mid-smile, natural candid crop.',
      'Hands running through hair, close-up on hands and partial face.',
      'Close-up of side of face, eyelashes prominent, shallow depth of field.',
      'Chin resting on folded hands, eyes looking up, intimate framing.',
      'Detail shot of eye corner and temple, natural skin texture, soft light.',
      'Close-up of nose and cheek in three-quarter profile, clean simple crop.',
      'Both hands pressed to cheeks, face squeezed softly, playful close-up.',
      'Forehead pressed to glass or surface, eyes open, intimate detail shot.',
      'Close-up of mouth mid-laugh, teeth visible, genuine emotion captured.',
      'One hand partially covering mouth in surprise, eyes wide, tight crop.',
      'Extreme close-up of iris and pupil, catchlight visible, maximum detail.',
    ],
  },
] as const

export function PromptHelpDialog({
  open, onClose, onAdd,
}: {
  open: boolean
  onClose: () => void
  onAdd: (prompts: string[]) => void
}) {
  const [activeTheme, setActiveTheme] = useState(0)
  const theme = PROMPT_THEMES[activeTheme]
  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl h-[600px] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
          <DialogTitle className="text-base">Prompt library</DialogTitle>
        </DialogHeader>
        <div className="flex border-b border-border shrink-0 px-5 gap-1">
          {PROMPT_THEMES.map((t, i) => (
            <button key={t.label} onClick={() => setActiveTheme(i)}
              className={`px-3 py-2 text-xs font-medium rounded-t transition-colors border-b-2 -mb-px ${i === activeTheme ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          <div className="space-y-1.5">
            {theme.prompts.map((p, i) => (
              <div key={i} className="flex items-start gap-2 group p-2 rounded-lg hover:bg-secondary/50 transition-colors">
                <span className="text-[10px] text-muted-foreground w-5 shrink-0 mt-0.5 text-right">{i + 1}</span>
                <p className="text-xs text-foreground flex-1 leading-relaxed">{p}</p>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => onAdd([p])}>
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border shrink-0 flex justify-between items-center">
          <span className="text-xs text-muted-foreground">{theme.prompts.length} prompts in this theme</span>
          <Button size="sm" onClick={() => onAdd([...theme.prompts])}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />Add all {theme.label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
