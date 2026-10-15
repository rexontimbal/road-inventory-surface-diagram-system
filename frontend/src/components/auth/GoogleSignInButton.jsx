import { useEffect, useRef } from 'react'

// Part 2 scope: wires up the real Google Identity Services flow (load
// script once, verify-by-backend on credential). Rendered here with
// Google's own default button styling as a functional placeholder --
// Part 3 relocates/reskins the trigger into the custom "Sign in to save
// your work" modal: this component itself (and its onCredential contract)
// stays the same, only where/how it's triggered changes.
let gisScriptPromise = null
function loadGoogleScript() {
  if (gisScriptPromise) return gisScriptPromise
  gisScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Sign-In script'))
    document.head.appendChild(script)
  })
  return gisScriptPromise
}

export default function GoogleSignInButton({ onCredential }) {
  const containerRef = useRef(null)
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID

  useEffect(() => {
    if (!clientId) return
    let cancelled = false

    loadGoogleScript()
      .then(() => {
        if (cancelled || !containerRef.current) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => onCredential(response.credential),
        })
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'medium',
          text: 'signin',
        })
      })
      .catch((err) => console.error(err))

    return () => {
      cancelled = true
    }
  }, [clientId, onCredential])

  if (!clientId) {
    return (
      <span className="header-auth-unconfigured" title="Set VITE_GOOGLE_CLIENT_ID to enable Google sign-in">
        Sign-in not configured
      </span>
    )
  }

  return <div ref={containerRef} className="google-signin-btn-slot" />
}
