'use client'

import { useEffect, useMemo, useState } from 'react'
import { Link2, Loader2, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface InstagramAccount {
  id: string
  name: string
  ig_username: string | null
  connected: boolean
}

interface ContentSourceMapping {
  id: string
  sheet_name: string
  instagram_account_id: string | null
  instagram_account_name: string | null
  ig_username: string | null
  active: boolean
}

function labelForAccount(account: InstagramAccount) {
  const username = account.ig_username || account.name
  return `${username}${account.connected ? ' connected' : ' not connected'}`
}

function selectedAccountLabel(accounts: InstagramAccount[], accountId: string | null) {
  if (!accountId) return 'Unassigned'
  const account = accounts.find(a => a.id === accountId)
  if (!account) return 'Selected account'
  return labelForAccount(account)
}

export function ContentSourceMappings() {
  const [accounts, setAccounts] = useState<InstagramAccount[]>([])
  const [mappings, setMappings] = useState<ContentSourceMapping[]>([])
  const [newSheetName, setNewSheetName] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)

  const sortedMappings = useMemo(() => {
    return [...mappings].sort((a, b) => a.sheet_name.localeCompare(b.sheet_name))
  }, [mappings])

  async function loadAll() {
    setLoading(true)
    try {
      const [accountsRes, mappingsRes] = await Promise.all([
        fetch('/api/instagram/accounts'),
        fetch('/api/content-source-mappings'),
      ])

      const accountsData = await accountsRes.json()
      const mappingsData = await mappingsRes.json()

      if (!accountsRes.ok) throw new Error(accountsData.error || 'Failed to load Instagram accounts')
      if (!mappingsRes.ok) throw new Error(mappingsData.error || 'Failed to load content source mappings')

      setAccounts(Array.isArray(accountsData) ? accountsData : [])
      setMappings(Array.isArray(mappingsData) ? mappingsData : [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load mappings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function saveMapping(sheetName: string, instagramAccountId: string | null) {
    const cleanSheetName = sheetName.trim()
    if (!cleanSheetName) {
      toast.error('Sheet name is required')
      return
    }

    setSavingKey(cleanSheetName)

    try {
      const res = await fetch('/api/content-source-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetName: cleanSheetName, instagramAccountId }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save mapping')

      toast.success('Content source mapping saved')
      setNewSheetName('')
      await loadAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save mapping')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold flex items-center gap-2">
            <Link2 className="w-4 h-4 text-pink-400" />
            Content Source Mappings
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Assign workbook sheets to Instagram accounts. If an account is banned, reassign the same sheet to a new account.
          </p>
        </div>

        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={loadAll} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      <div className="flex gap-2">
        <Input
          value={newSheetName}
          onChange={e => setNewSheetName(e.target.value)}
          placeholder="Add sheet name, e.g. yan.nami19"
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          className="h-8 text-xs shrink-0"
          disabled={!newSheetName.trim() || savingKey === newSheetName.trim()}
          onClick={() => saveMapping(newSheetName, null)}
        >
          {savingKey === newSheetName.trim()
            ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            : <Save className="w-3 h-3 mr-1" />
          }
          Add
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : sortedMappings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-center">
          <p className="text-sm text-muted-foreground">No content sources yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Import the schedule workbook first, or manually add a sheet name above.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedMappings.map(mapping => (
            <div key={mapping.id} className="grid grid-cols-[minmax(160px,1fr)_minmax(240px,1.4fr)_auto] gap-3 items-center rounded-lg border border-border bg-background/40 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{mapping.sheet_name}</p>
                <p className="text-xs text-muted-foreground">
                  {mapping.instagram_account_id
                    ? `Assigned to @${mapping.ig_username || mapping.instagram_account_name || 'account'}`
                    : 'Unassigned'}
                </p>
              </div>

              <Select
                value={mapping.instagram_account_id || '__none__'}
                onValueChange={value => saveMapping(mapping.sheet_name, value === '__none__' ? null : value)}
              >
                <SelectTrigger className="h-8 text-xs">
                  {selectedAccountLabel(accounts, mapping.instagram_account_id)}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Unassigned</SelectItem>
                  {accounts.map(account => (
                    <SelectItem key={account.id} value={account.id}>
                      {labelForAccount(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={savingKey === mapping.sheet_name}
                onClick={() => saveMapping(mapping.sheet_name, mapping.instagram_account_id)}
              >
                {savingKey === mapping.sheet_name
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : 'Save'
                }
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


