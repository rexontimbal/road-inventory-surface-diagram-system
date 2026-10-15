import { useEffect, useRef } from 'react'

// Renders Google's own "Continue with Google" button (inside SignInModal --
// Google's branding guidelines require using their rendered button as-is,
// not a custom-styled lookalike). error_callback only fires for GIS-level
// failures BEFORE a credential exists (popup blocked/closed, FedCM
// unavailable, etc.) -- it does not carry a reason code for "this Google
// account isn't an allowed test user" specifically. Google blocks that
// case entirely inside its own hosted consent screen, so from this page's
// side it's indistinguishable from the user just closing the popup; the
// caller (SignInModal) shows its friendly message on any failure AFTER a
// credential is actually obtained and rejected by our own backend, which
// is the one place that case reliably surfaces.
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

export default function GoogleSignInButton({ onCredential, onError }) {
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
          error_callback: (err) => {
            if (err?.type === 'popup_closed') return // user just closed it, not an error worth surfacing
            onError?.("Couldn't start Google sign-in. Please try again.")
          },
        })
        window.google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          width: 280,
        })
      })
      .catch((err) => {
        console.error(err)
        onError?.("Couldn't load Google sign-in. Please try again.")
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  if (!clientId) {
    return (
      <span className="signin-modal-unconfigured" title="Set VITE_GOOGLE_CLIENT_ID to enable Google sign-in">
        Google sign-in is not configured yet.
      </span>
    )
  }

  return <div ref={containerRef} className="google-signin-btn-slot" />
}
