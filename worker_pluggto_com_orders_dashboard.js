// ===============================
// CORS
// ===============================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  })
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/plain" }
  })
}

async function getValidAccessToken(env) {
  const accessToken = await env.TOKENS.get("access_token")
  const refreshToken = await env.TOKENS.get("refresh_token")

  if (!accessToken || !refreshToken) throw new Error("Tokens não encontrados no KV")

  const testResponse = await fetch(
    `https://api.plugg.to/orders?limit=1&access_token=${accessToken}`
  )

  if (testResponse.ok) return accessToken

  const basicAuth = btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`)
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  })

  const refreshResponse = await fetch("https://api.plugg.to/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  })

  if (!refreshResponse.ok) {
    throw new Error("Erro ao renovar token: " + await refreshResponse.text())
  }

  const data = await refreshResponse.json()
  await env.TOKENS.put("access_token", data.access_token)
  if (data.refresh_token) await env.TOKENS.put("refresh_token", data.refresh_token)
  return data.access_token
}

async function buscarEstoquePluggto(env) {
  const accessToken = await getValidAccessToken(env)
  const lista = []
  let page = 1
  const limit = 100

  while (true) {
    const url = new URL(env.PLUGGTO_PRODUCTS_URL || "https://api.plugg.to/products")
    url.searchParams.set("limit", String(limit))
    url.searchParams.set("page", String(page))
    url.searchParams.set("access_token", accessToken)

    const response = await fetch(url.toString())
    const body = await response.text()
    if (!response.ok) throw new Error(`Erro Plugg.to produtos página ${page}: ${response.status} - ${body}`)

    const data = JSON.parse(body)
    const resultados = data.result || []
    if (resultados.length === 0) break

    for (const item of resultados) {
      const produto = item.Product || {}
      for (const variacao of produto.variations || []) {
        const sku = String(variacao.sku || "").trim().toUpperCase()
        const quantity = Number(variacao.quantity || 0)
        if (!sku) continue
        lista.push({ sku, quantity, estoqueCalculado: quantity, estoqueFinal: Math.max(0, quantity) })
      }
    }

    if (resultados.length < limit) break
    page++
  }

  return lista
}

function headersNuvemshop(env) {
  return {
    "Authentication": `bearer ${env.NUVEMSHOP_TOKEN}`,
    "User-Agent": "API Pluggto (#31270)",
    "Content-Type": "application/json",
    "Accept": "application/json"
  }
}

async function buscarMapaSkuNuvemshop(env) {
  const mapa = {}
  let page = 1
  const perPage = 200

  while (true) {
    const url = `https://api.tiendanube.com/v1/${env.NUVEMSHOP_STORE_ID}/products?page=${page}&per_page=${perPage}`
    const response = await fetch(url, { method: "GET", headers: headersNuvemshop(env) })
    const body = await response.text()
    if (!response.ok) throw new Error(`Erro buscando produtos Nuvemshop página ${page}: ${response.status} - ${body}`)

    const produtos = JSON.parse(body)
    if (!Array.isArray(produtos) || produtos.length === 0) break

    for (const produto of produtos) {
      for (const variacao of produto.variants || []) {
        const sku = String(variacao.sku || "").trim().toUpperCase()
        if (!sku) continue
        mapa[sku] = {
          product_id: variacao.product_id || produto.id,
          variant_id: variacao.id,
          stock_atual: Number(variacao.stock || 0)
        }
      }
    }

    if (produtos.length < perPage) break
    page++
  }

  return mapa
}

async function obterMapaSkuNuvemshop(env) {
  const mapaSalvo = await env.ESTOQUE_CACHE.get("nuvem_sku_map")
  if (!mapaSalvo) throw new Error("Mapa SKU da Nuvemshop não encontrado. Rode /rebuild-map primeiro.")
  return JSON.parse(mapaSalvo)
}

async function atualizarEstoqueNuvemshop(env, productId, variantId, estoque) {
  const estoqueSeguro = Math.max(0, Number(estoque || 0))
  const url = `https://api.tiendanube.com/v1/${env.NUVEMSHOP_STORE_ID}/products/${productId}/variants/${variantId}`
  const response = await fetch(url, {
    method: "PUT",
    headers: headersNuvemshop(env),
    body: JSON.stringify({ stock: estoqueSeguro })
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Erro atualizando estoque Nuvemshop: ${response.status} - ${body}`)
  return body ? JSON.parse(body) : {}
}

async function limparEstoqueCache(env) {
  const chavesFixas = ["nuvem_sku_map", "ultimo_resumo", "pendentes_sync", "ultimo_estoque_pluggto"]
  let apagadas = 0
  for (const chave of chavesFixas) { await env.ESTOQUE_CACHE.delete(chave); apagadas++ }

  let cursor = undefined
  do {
    const listagem = await env.ESTOQUE_CACHE.list({ prefix: "estoque:", cursor })
    for (const key of listagem.keys) { await env.ESTOQUE_CACHE.delete(key.name); apagadas++ }
    cursor = listagem.cursor
  } while (cursor)

  return { success: true, message: "Cache limpo com sucesso", chavesApagadas: apagadas, executadoEm: new Date().toISOString() }
}

async function sincronizarEstoques(env) {
  const MAX_ATUALIZACOES_POR_EXECUCAO = 150
  const resumo = {
    totalPluggto: 0, alteradosDetectados: 0, pendentesAntes: 0,
    processadosNestaExecucao: 0, atualizados: 0, semAlteracao: 0,
    naoEncontrados: 0, pendentesDepois: 0, erros: [], executadoEm: new Date().toISOString()
  }

  const estoquePluggtoLista = await buscarEstoquePluggto(env)
  const mapaNuvem = await obterMapaSkuNuvemshop(env)
  resumo.totalPluggto = estoquePluggtoLista.length

  const estoqueAtual = {}
  for (const item of estoquePluggtoLista) {
    const sku = String(item.sku || "").trim().toUpperCase()
    estoqueAtual[sku] = Math.max(0, Number(item.estoqueFinal || 0))
  }

  const estoqueAnteriorRaw = await env.ESTOQUE_CACHE.get("ultimo_estoque_pluggto")
  const estoqueAnterior = estoqueAnteriorRaw ? JSON.parse(estoqueAnteriorRaw) : null
  const pendentesRaw = await env.ESTOQUE_CACHE.get("pendentes_sync")
  let pendentes = pendentesRaw ? JSON.parse(pendentesRaw) : []
  resumo.pendentesAntes = pendentes.length

  const pendentesMap = {}
  for (const p of pendentes) {
    const sku = String(p.sku || "").trim().toUpperCase()
    pendentesMap[sku] = { sku, estoqueFinal: Math.max(0, Number(p.estoqueFinal || 0)) }
  }

  for (const sku of Object.keys(estoqueAtual)) {
    const estoqueFinal = Math.max(0, Number(estoqueAtual[sku] || 0))
    if (estoqueAnterior) {
      const estoqueAntes = estoqueAnterior[sku]
      if (estoqueAntes === undefined || Number(estoqueAntes) !== estoqueFinal) {
        pendentesMap[sku] = { sku, estoqueFinal }
        resumo.alteradosDetectados++
      }
    } else {
      const itemNuvem = mapaNuvem[sku]
      if (!itemNuvem || Number(itemNuvem.stock_atual || 0) !== estoqueFinal) {
        pendentesMap[sku] = { sku, estoqueFinal }
        resumo.alteradosDetectados++
      }
    }
  }

  pendentes = Object.values(pendentesMap)
  const lote = pendentes.slice(0, MAX_ATUALIZACOES_POR_EXECUCAO)
  const restantes = pendentes.slice(MAX_ATUALIZACOES_POR_EXECUCAO)

  for (const item of lote) {
    const sku = String(item.sku || "").trim().toUpperCase()
    const estoqueFinal = Math.max(0, Number(item.estoqueFinal || 0))
    try {
      const variacao = mapaNuvem[sku]
      if (!variacao) {
        resumo.naoEncontrados++
        resumo.erros.push(`SKU não encontrado no mapa da Nuvemshop: ${sku}`)
        resumo.processadosNestaExecucao++
        continue
      }
      await atualizarEstoqueNuvemshop(env, variacao.product_id, variacao.variant_id, estoqueFinal)
      resumo.atualizados++
      resumo.processadosNestaExecucao++
      await sleep(500)
    } catch (err) {
      restantes.push({ sku, estoqueFinal })
      resumo.erros.push(`${sku}: ${err.message}`)
      resumo.processadosNestaExecucao++
    }
  }

  resumo.semAlteracao = resumo.totalPluggto - resumo.alteradosDetectados
  resumo.pendentesDepois = restantes.length
  await env.ESTOQUE_CACHE.put("pendentes_sync", JSON.stringify(restantes))
  await env.ESTOQUE_CACHE.put("ultimo_estoque_pluggto", JSON.stringify(estoqueAtual))
  await env.ESTOQUE_CACHE.put("ultimo_resumo", JSON.stringify(resumo))
  return resumo
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function chaveCachePedidosDashboard(url) {
  const start = url.searchParams.get("start") || ""
  const end = url.searchParams.get("end") || ""
  const next = url.searchParams.get("next") || "inicio"
  const since = url.searchParams.get("since") || "inicio"
  return `painel-margem:orders:v4:all-except-canceled-pending:${start}:${end}:${since}:${next}`
}

const CHAVE_PMC_DASHBOARD = "painel-margem:pmc"
const CHAVE_CUSTOS_DASHBOARD = "painel-margem:costs"

function normalizarMapaPmc(valor) {
  const origem = valor && typeof valor === "object" && valor.pmc && typeof valor.pmc === "object" ? valor.pmc : valor
  const mapa = {}
  for (const [skuOriginal, pmc] of Object.entries(origem || {})) {
    const sku = String(skuOriginal || "").replace(/^\*/, "").replace(/-/g, "").trim().toUpperCase()
    const textoPmc = String(pmc ?? 0).trim()
    const valorPmc = typeof pmc === "number" ? pmc : Number(textoPmc.includes(",") ? textoPmc.replace(/\./g, "").replace(",", ".") : textoPmc)
    if (sku && Number.isFinite(valorPmc)) mapa[sku] = valorPmc
  }
  return mapa
}

async function obterPmcDashboard(env) {
  if (!env.ESTOQUE_CACHE) return {}
  const salvo = await env.ESTOQUE_CACHE.get(CHAVE_PMC_DASHBOARD, "json")
  return salvo && typeof salvo === "object" ? salvo : {}
}

async function pmcDashboard(env, request) {
  if (!env.ESTOQUE_CACHE) return jsonResponse({ error: "Binding ESTOQUE_CACHE não encontrado" }, 500)

  if (request.method === "GET") {
    return new Response(JSON.stringify(await obterPmcDashboard(env)), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
    })
  }

  if (request.method === "POST") {
    let payload
    try { payload = await request.json() } catch { return jsonResponse({ error: "JSON inválido" }, 400) }
    const mapa = normalizarMapaPmc(payload)
    await env.ESTOQUE_CACHE.put(CHAVE_PMC_DASHBOARD, JSON.stringify(mapa))
    return jsonResponse({ success: true, totalSkus: Object.keys(mapa).length, atualizadoEm: new Date().toISOString() })
  }

  return jsonResponse({ error: "Método não permitido" }, 405)
}

function normalizarCustosDashboard(valor) {
  const origem = valor && typeof valor === "object" && valor.costs && typeof valor.costs === "object" ? valor.costs : valor
  const custos = {}
  for (const [chave, item] of Object.entries(origem || {})) {
    if (!item || typeof item !== "object") continue
    const platform = String(item.platform || "").trim()
    if (!platform) continue
    const name = String(item.name || "Custo").trim() || "Custo"
    const decimal = value => {
      const text = String(value ?? 0).trim()
      return Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text)
    }
    const rate = decimal(item.rate)
    const fix = decimal(item.fix)
    custos[String(chave)] = { platform, name, rate: Number.isFinite(rate) ? rate : 0, fix: Number.isFinite(fix) ? fix : 0 }
  }
  return custos
}

async function custosDashboard(env, request) {
  if (!env.ESTOQUE_CACHE) return jsonResponse({ error: "Binding ESTOQUE_CACHE não encontrado" }, 500)
  if (request.method === "GET") {
    const salvo = await env.ESTOQUE_CACHE.get(CHAVE_CUSTOS_DASHBOARD, "json")
    return jsonResponse(salvo && typeof salvo === "object" ? salvo : {})
  }
  if (request.method === "POST") {
    let payload
    try { payload = await request.json() } catch { return jsonResponse({ error: "JSON inválido" }, 400) }
    const custos = normalizarCustosDashboard(payload)
    await env.ESTOQUE_CACHE.put(CHAVE_CUSTOS_DASHBOARD, JSON.stringify(custos))
    return jsonResponse({ success: true, totalCustos: Object.keys(custos).length, atualizadoEm: new Date().toISOString() })
  }
  return jsonResponse({ error: "Método não permitido" }, 405)
}

// Rota isolada do painel. A rota /orders existente não é alterada.
async function pedidosDashboard(env, url) {
  const start = url.searchParams.get("start")
  const end = url.searchParams.get("end")
  const next = url.searchParams.get("next")
  const since = url.searchParams.get("since")
  const atualizarCache = url.searchParams.get("refresh") === "1"

  if (!start || !end) return jsonResponse({ error: "start e end são obrigatórios" }, 400)

  const cacheKey = chaveCachePedidosDashboard(url)
  if (!atualizarCache && env.ESTOQUE_CACHE) {
    const cachedBody = await env.ESTOQUE_CACHE.get(cacheKey)
    if (cachedBody) {
      return new Response(cachedBody, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Orders-Cache": "HIT" }
      })
    }
  }

  const accessToken = await getValidAccessToken(env)
  const pluggtoUrl = new URL("https://api.plugg.to/orders")
  pluggtoUrl.searchParams.set("limit", "100")
  pluggtoUrl.searchParams.set("created", since ? `${since}to${end}T23:59:59.999Z` : `${start}T00:00:00.000Zto${end}T23:59:59.999Z`)
  pluggtoUrl.searchParams.set("access_token", accessToken)
  if (next) pluggtoUrl.searchParams.set("next", next)

  const response = await fetch(pluggtoUrl.toString())
  const body = await response.text()

  if (!response.ok) {
    return jsonResponse({ error: "Erro Plugg.to", status: response.status, body }, 500)
  }

  if (env.ESTOQUE_CACHE) await env.ESTOQUE_CACHE.put(cacheKey, body)

  return new Response(body, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Orders-Cache": "MISS" }
  })
}

// ================================
// Worker principal
// ================================
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url)

      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders })
      if (url.pathname === "/") return textResponse("ok")

      if (url.pathname === "/clear-cache") {
        return jsonResponse(await limparEstoqueCache(env))
      }

      if (url.pathname === "/rebuild-map") {
        const mapa = await buscarMapaSkuNuvemshop(env)
        await env.ESTOQUE_CACHE.put("nuvem_sku_map", JSON.stringify(mapa))
        return jsonResponse({ message: "Mapa SKU Nuvemshop criado com sucesso", totalSkus: Object.keys(mapa).length, executadoEm: new Date().toISOString() })
      }

      if (url.pathname === "/sync-stock") return jsonResponse(await sincronizarEstoques(env))

      if (url.pathname === "/stock-status") {
        const resumo = await env.ESTOQUE_CACHE.get("ultimo_resumo")
        return new Response(resumo || JSON.stringify({ message: "Ainda sem execução" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }

      if (url.pathname === "/sync-one") {
        const sku = String(url.searchParams.get("sku") || "").trim().toUpperCase()
        if (!sku) return jsonResponse({ error: "Informe o SKU. Ex: /sync-one?sku=10264900136C" }, 400)

        const estoquePluggto = await buscarEstoquePluggto(env)
        const item = estoquePluggto.find(p => String(p.sku || "").trim().toUpperCase() === sku)
        if (!item) return jsonResponse({ error: "SKU não encontrado na Plugg.to", sku }, 404)

        const mapaNuvem = await obterMapaSkuNuvemshop(env)
        const variacao = mapaNuvem[sku]
        if (!variacao) return jsonResponse({ error: "SKU não encontrado no mapa da Nuvemshop. Rode /rebuild-map.", sku }, 404)

        const estoqueFinal = Math.max(0, Number(item.estoqueFinal || 0))
        await atualizarEstoqueNuvemshop(env, variacao.product_id, variacao.variant_id, estoqueFinal)
        return jsonResponse({ sku, estoquePluggtoCalculado: item.estoqueCalculado ?? estoqueFinal, estoqueEnviadoNuvemshop: estoqueFinal, product_id: variacao.product_id, variant_id: variacao.variant_id, atualizado: true })
      }

      // Cache compartilhado de PMCs do painel. Não altera nenhuma rota existente.
      if (url.pathname === "/orders-dashboard-pmc") {
        return await pmcDashboard(env, request)
      }

      // Custos do painel compartilhados entre navegadores e aparelhos.
      if (url.pathname === "/orders-dashboard-costs") {
        return await custosDashboard(env, request)
      }

      // Nova rota exclusiva do painel. A rota /orders abaixo permanece igual.
      if (url.pathname === "/orders-dashboard") {
        return await pedidosDashboard(env, url)
      }

      // ================================
      // ROTA EXISTENTE DO DASHBOARD / POWER BI
      // ================================
      if (url.pathname !== "/orders") return textResponse("Not found", 404)

      const start = url.searchParams.get("start")
      const end = url.searchParams.get("end")
      if (!start || !end) return jsonResponse({ error: "start e end são obrigatórios" }, 400)

      const accessToken = await getValidAccessToken(env)
      const pluggtoUrl = `https://api.plugg.to/orders?limit=500&created=${start}T00:00:00.000Zto${end}T23:59:59.999Z&access_token=${accessToken}`
      const response = await fetch(pluggtoUrl)
      const body = await response.text()

      if (!response.ok) return jsonResponse({ error: "Erro Plugg.to", status: response.status, body }, 500)

      return new Response(body, { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } })
    } catch (err) {
      return jsonResponse({ error: "Worker crash", message: err.message }, 500)
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sincronizarEstoques(env))
  }
}
