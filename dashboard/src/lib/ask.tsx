import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/** "Ask Eris" hand-off: any page can queue a question; Conversations opens a new chat and sends it. */
interface AskState {
  ask: string | null
  askEris: (text: string) => void
  clearAsk: () => void
}
const Ctx = createContext<AskState>({ ask: null, askEris: () => {}, clearAsk: () => {} })
export const useAsk = () => useContext(Ctx)

export function AskProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<string | null>(null)
  const askEris = useCallback((text: string) => {
    setAsk(text)
    window.location.hash = '#/conversations'
  }, [])
  const clearAsk = useCallback(() => setAsk(null), [])
  const value = useMemo(() => ({ ask, askEris, clearAsk }), [ask, askEris, clearAsk])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
