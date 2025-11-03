/**
 * Инициация GitHub OAuth flow
 *
 * Аналогично Google, но с GitHub endpoints:
 * - Authorization: https://github.com/login/oauth/authorize
 * - Scopes: read:user user:email
 */

import { generatePKCE, storeState, buildOAuthUrl } from '../../lib/oauth'

export async function GET(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!(path.endsWith('/github/start') || path.endsWith('/oauth/github/start'))) {
    return new Response('Not Found', { status: 404 })
  }

  const client_id = env.GITHUB_CLIENT_ID
  const redirect_base = env.OAUTH_REDIRECT_BASE
  if (!client_id || !redirect_base) {
    return new Response('GitHub OAuth misconfigured', { status: 500 })
  }

  // 1. Генерация state + PKCE
  const state = crypto.randomUUID()
  const { verifier, challenge } = await generatePKCE()

  // 2. Сохранение state в KV
  await storeState(env, 'github', state, verifier)

  // 3. Редирект на GitHub OAuth
  const redirect_uri = `${redirect_base}/auth/github/callback`
  const authUrl = buildOAuthUrl('https://github.com/login/oauth/authorize', {
    client_id,
    redirect_uri,
    scope: 'read:user user:email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })

  return Response.redirect(authUrl, 302)
}

