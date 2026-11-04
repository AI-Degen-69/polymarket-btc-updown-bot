import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'

import { Shell } from './components/Shell'
import { ToastProvider } from './components/ui'
import { Config } from './pages/Config'
import { Dashboard } from './pages/Dashboard'
import { Live } from './pages/Live'
import { Strategy } from './pages/Strategy'

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
})

export function App() {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="live" element={<Live />} />
              <Route path="config" element={<Config />} />
              <Route path="strategy" element={<Strategy />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
