'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { usersStore, charactersStore } from '@/lib/store'
import { User, Character } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  Users,
  Plus,
  Trash2,
  UserCheck,
  UserX,
  Edit2,
  Save,
  X,
  ImageIcon,
  ShieldCheck,
} from 'lucide-react'

// ─────────────────────────────────────────────
// USERS TAB
// ─────────────────────────────────────────────
function UsersTab() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'chatter' as 'admin' | 'chatter' })
  const [editForm, setEditForm] = useState<Partial<User & { password: string }>>({})

  useEffect(() => { setUsers(usersStore.getAll()) }, [])

  function refresh() { setUsers(usersStore.getAll()) }

  function addUser() {
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      toast.error('All fields are required')
      return
    }
    if (usersStore.findByEmail(form.email)) {
      toast.error('Email already exists')
      return
    }
    usersStore.add({
      id: crypto.randomUUID(),
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      password: form.password,
      role: form.role,
      createdAt: new Date().toISOString(),
      active: true,
    })
    setForm({ name: '', email: '', password: '', role: 'chatter' })
    refresh()
    toast.success('User added')
  }

  function toggleActive(u: User) {
    if (u.id === currentUser?.id) { toast.error('You cannot deactivate yourself'); return }
    usersStore.update(u.id, { active: !u.active })
    refresh()
  }

  function deleteUser(u: User) {
    if (u.id === currentUser?.id) { toast.error('You cannot delete yourself'); return }
    usersStore.delete(u.id)
    setDeleteTarget(null)
    refresh()
    toast.success('User deleted')
  }

  function startEdit(u: User) {
    setEditTarget(u.id)
    setEditForm({ name: u.name, email: u.email, role: u.role, password: '' })
  }

  function saveEdit(u: User) {
    const update: Partial<User> = {}
    if (editForm.name?.trim()) update.name = editForm.name.trim()
    if (editForm.email?.trim()) update.email = editForm.email.trim().toLowerCase()
    if (editForm.role) update.role = editForm.role
    if (editForm.password?.trim()) (update as Record<string, unknown>).password = editForm.password.trim()
    usersStore.update(u.id, update)
    setEditTarget(null)
    refresh()
    toast.success('Changes saved')
  }

  return (
    <div className="space-y-6">
      {/* Add user */}
      <Card className="border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Plus className="w-4 h-4 text-primary" />
            Add user
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                placeholder="First Last"
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className="bg-input border-border h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Email</Label>
              <Input
                type="email"
                placeholder="email@primjer.com"
                value={form.email}
                onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Password</Label>
              <Input
                type="password"
                placeholder="••••••••"
                value={form.password}
                onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Role</Label>
              <Select value={form.role} onValueChange={(v: string | null) => { if (v) setForm(p => ({ ...p, role: v as 'admin' | 'chatter' })) }}>
                <SelectTrigger className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chatter">Chatter</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button size="sm" onClick={addUser}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add user
          </Button>
        </CardContent>
      </Card>

      {/* Users list */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
          All users ({users.length})
        </p>
        {users.map(u => (
          <Card key={u.id} className={`border-[rgba(255,255,255,0.12)] ${!u.active ? 'opacity-60' : ''}`}>
            <CardContent className="p-4">
              {editTarget === u.id ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Input
                      value={editForm.name ?? ''}
                      onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                      className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm"
                      placeholder="Name"
                    />
                    <Input
                      value={editForm.email ?? ''}
                      onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))}
                      className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm"
                      placeholder="Email"
                    />
                    <Input
                      type="password"
                      value={editForm.password ?? ''}
                      onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))}
                      className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm"
                      placeholder="New password (optional)"
                    />
                    <Select value={editForm.role} onValueChange={(v: string | null) => { if (v) setEditForm(p => ({ ...p, role: v as 'admin' | 'chatter' })) }}>
                      <SelectTrigger className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chatter">Chatter</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-xs" onClick={() => saveEdit(u)}>
                      <Save className="w-3 h-3 mr-1" />Save
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditTarget(null)}>
                      <X className="w-3 h-3 mr-1" />Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                    {u.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{u.name}</span>
                      {u.role === 'admin' && (
                        <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                      )}
                      <Badge
                        variant={u.active ? 'secondary' : 'outline'}
                        className="text-xs h-4 px-1.5"
                      >
                        {u.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="w-7 h-7 text-muted-foreground hover:text-foreground"
                      onClick={() => startEdit(u)}
                      title="Uredi"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={`w-7 h-7 ${u.active ? 'text-muted-foreground hover:text-yellow-500' : 'text-muted-foreground hover:text-green-500'}`}
                      onClick={() => toggleActive(u)}
                      title={u.active ? 'Deactivate' : 'Activate'}
                    >
                      {u.active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                    </Button>
                    {u.id !== currentUser?.id && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="w-7 h-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(u)}
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent className="bg-[rgba(255,255,255,0.04)] border-[rgba(255,255,255,0.12)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteUser(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─────────────────────────────────────────────
// CHARACTER FORM (module-level to preserve focus)
// ─────────────────────────────────────────────
function CharacterForm({ form, onChange }: { form: Partial<Character>; onChange: (f: Partial<Character>) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Name</Label>
          <Input value={form.name ?? ''} onChange={e => onChange({ ...form, name: e.target.value })} className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Mode</Label>
          <Select value={form.defaultMode ?? 'SFW'} onValueChange={(v: string | null) => { if (v) onChange({ ...form, defaultMode: v as 'SFW' | 'NSFW' }) }}>
            <SelectTrigger className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="SFW">SFW</SelectItem>
              <SelectItem value="NSFW">NSFW</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label className="text-xs text-muted-foreground">LoRA URL (HuggingFace)</Label>
          <Input value={form.loraUrl ?? ''} onChange={e => onChange({ ...form, loraUrl: e.target.value })} className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm" placeholder="https://huggingface.co/..." />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">LoRA Scale</Label>
          <Input type="number" step="0.1" min="0" max="1" value={form.loraScale ?? 0.8} onChange={e => onChange({ ...form, loraScale: parseFloat(e.target.value) })} className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Start Date</Label>
          <Input type="date" value={form.startDate ?? ''} onChange={e => onChange({ ...form, startDate: e.target.value })} className="bg-[rgba(255,255,255,0.08)] border-[rgba(255,255,255,0.12)] h-8 text-sm" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Base Prompt Style</Label>
        <Textarea value={form.basePromptStyle ?? ''} onChange={e => onChange({ ...form, basePromptStyle: e.target.value })} rows={3} className="bg-input border-border text-xs resize-none" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Character Story</Label>
        <Textarea value={form.story ?? ''} onChange={e => onChange({ ...form, story: e.target.value })} rows={4} className="bg-input border-border text-xs resize-none" />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// CHARACTERS TAB
// ─────────────────────────────────────────────
function CharactersTab() {
  const [characters, setCharacters] = useState<Character[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Partial<Character>>({})
  const [adding, setAdding] = useState(false)
  const [newForm, setNewForm] = useState<Partial<Character>>({
    name: '', loraUrl: '', loraScale: 0.8, basePromptStyle: '', story: '', startDate: '', defaultMode: 'SFW',
  })

  useEffect(() => { setCharacters(charactersStore.getAll()) }, [])
  function refresh() { setCharacters(charactersStore.getAll()) }

  function addCharacter() {
    if (!newForm.name?.trim()) { toast.error('Name is required'); return }
    charactersStore.add({
      id: crypto.randomUUID(),
      name: newForm.name!.trim(),
      loraUrl: newForm.loraUrl ?? '',
      loraScale: newForm.loraScale ?? 0.8,
      basePromptStyle: newForm.basePromptStyle ?? '',
      story: newForm.story ?? '',
      startDate: newForm.startDate ?? '',
      defaultMode: newForm.defaultMode ?? 'SFW',
    })
    setAdding(false)
    setNewForm({ name: '', loraUrl: '', loraScale: 0.8, basePromptStyle: '', story: '', startDate: '', defaultMode: 'SFW' })
    refresh()
    toast.success('Character added')
  }

  function saveEdit() {
    if (!editId) return
    charactersStore.update(editId, editForm)
    setEditId(null)
    refresh()
    toast.success('Character updated')
  }

  function deleteChar(id: string) {
    charactersStore.delete(id)
    refresh()
    toast.success('Character deleted')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Characters ({characters.length})
        </p>
        <Button size="sm" className="h-7 text-xs" onClick={() => setAdding(true)}>
          <Plus className="w-3 h-3 mr-1" />
          New character
        </Button>
      </div>

      {adding && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">New character</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <CharacterForm form={newForm} onChange={setNewForm} />
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={addCharacter}>
                <Save className="w-3 h-3 mr-1" />Save
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(false)}>
                <X className="w-3 h-3 mr-1" />Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {characters.map(char => (
        <Card key={char.id} className="border-border/50">
          <CardContent className="p-4">
            {editId === char.id ? (
              <div className="space-y-3">
                <CharacterForm form={editForm} onChange={setEditForm} />
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs" onClick={saveEdit}>
                    <Save className="w-3 h-3 mr-1" />Save
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditId(null)}>
                    <X className="w-3 h-3 mr-1" />Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                  <ImageIcon className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-sm">{char.name}</span>
                    <Badge variant={char.defaultMode === 'NSFW' ? 'destructive' : 'secondary'} className="text-xs h-4 px-1.5">
                      {char.defaultMode}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{char.story || 'No description'}</p>
                  {char.loraUrl && (
                    <p className="text-xs text-primary/70 truncate mt-1">{char.loraUrl}</p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="w-7 h-7 text-muted-foreground hover:text-foreground"
                    onClick={() => { setEditId(char.id); setEditForm({ ...char }) }}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="w-7 h-7 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteChar(char.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────
// ADMIN PAGE
// ─────────────────────────────────────────────
export default function AdminPage() {
  const { user } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (user && user.role !== 'admin') router.push('/generate')
  }, [user, router])

  if (!user || user.role !== 'admin') return null

  return (
    <div className="p-3 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Users className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-bold">Admin Panel</h1>
      </div>

      <Tabs defaultValue="users">
        <TabsList className="mb-6 bg-secondary border border-border/50">
          <TabsTrigger value="users" className="text-sm">
            <Users className="w-3.5 h-3.5 mr-1.5" />
            Users
          </TabsTrigger>
          <TabsTrigger value="characters" className="text-sm">
            <ImageIcon className="w-3.5 h-3.5 mr-1.5" />
            Characters
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="characters">
          <CharactersTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
