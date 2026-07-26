'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldHint, FieldLabel } from '@/components/ui/field'
import { BookmarkPlus, Check, Trash2 } from 'lucide-react'
import {
  deleteRecipe,
  listRecipes,
  saveRecipe,
  type CopyPasteRecipe,
} from '@/lib/monitor/recipes'
import {
  IMAGE_MODEL_LABEL,
  SOUND_OPTIONS,
  VIDEO_BACKEND_OPTIONS,
  useStudioSettings,
} from './studio-settings'

export function RecipesTab() {
  const studio = useStudioSettings()
  const [recipes, setRecipes] = useState<CopyPasteRecipe[]>([])
  const [name, setName] = useState('')

  function refresh() {
    setRecipes(listRecipes())
  }

  useEffect(() => {
    refresh()
  }, [studio.recipesVersion])

  function saveCurrent() {
    if (!name.trim()) {
      toast.error('Name the recipe first')
      return
    }
    saveRecipe({
      name: name.trim(),
      imageModel: studio.imageModel,
      seedreamResolution: studio.seedreamResolution,
      videoBackend: studio.videoBackend,
      sound: studio.sound,
    })
    studio.bumpRecipes()
    setName('')
    refresh()
    toast.success('Recipe saved')
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle>Save current setup</CardTitle>
          <CardDescription>
            Snapshot the Run toolbar (image, video, sound) so you can reapply it later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{IMAGE_MODEL_LABEL[studio.imageModel]}</Badge>
            {studio.imageModel === 'seedream_edit' && (
              <Badge variant="outline">{studio.seedreamResolution}</Badge>
            )}
            <Badge variant="outline">
              {VIDEO_BACKEND_OPTIONS.find(o => o.value === studio.videoBackend)?.label}
            </Badge>
            <Badge variant="outline">
              {SOUND_OPTIONS.find(o => o.value === studio.sound)?.label}
            </Badge>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field className="flex-1 min-w-[220px]">
              <FieldLabel>Recipe name</FieldLabel>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Seedream 2k + Seedance silent"
                onKeyDown={e => e.key === 'Enter' && saveCurrent()}
              />
              <FieldHint>Stored in this browser (localStorage).</FieldHint>
            </Field>
            <Button onClick={saveCurrent}>
              <BookmarkPlus className="w-4 h-4" />
              Save recipe
            </Button>
          </div>
        </CardContent>
      </Card>

      {recipes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No recipes yet. Configure Run, then save a preset here.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {recipes.map(r => {
            const active = studio.activeRecipeId === r.id
            return (
              <Card key={r.id} className={active ? 'ring-1 ring-primary/40' : undefined}>
                <CardContent className="pt-1">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-base">{r.name}</h3>
                        {active && (
                          <Badge className="bg-primary/15 text-primary border-primary/20">
                            <Check className="w-3 h-3 mr-1" /> Active
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {IMAGE_MODEL_LABEL[r.imageModel]}
                        {r.imageModel === 'seedream_edit' ? ` ${r.seedreamResolution}` : ''}
                        {' · '}
                        {VIDEO_BACKEND_OPTIONS.find(o => o.value === r.videoBackend)?.label}
                        {' · '}
                        {SOUND_OPTIONS.find(o => o.value === r.sound)?.label}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Saved {new Date(r.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={() => studio.applyRecipe(r)}>Apply</Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          deleteRecipe(r.id)
                          studio.bumpRecipes()
                          refresh()
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
