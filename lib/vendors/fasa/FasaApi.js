/* global env, variables, setVariable, axios */

/**
 * FASA (Gensys/Oracle APEX ORDS) API Adapter
 *
 * Catálogo de vehículos BMW / MINI / BMW MOTOS que FASA expone sobre Oracle
 * APEX ORDS, protegido con OAuth 2.0 (client_credentials).
 *
 * Ref. DOC-FASA-PROLIBU-2026-001 · https://serviciocrm.fasa.com.pa/ords/bmw_pan
 *
 * La cadena del catálogo es estrictamente jerárquica — cada nivel necesita
 * todos los anteriores:
 *
 *   Marcas → modelos/{marca} → grados/{marca}/{modelo}
 *          → anios/{marca}/{modelo}/{grado}
 *          → precios|especificaciones/{marca}/{modelo}/{grado}/{anio}
 *
 * @class FasaApi
 *
 * @example
 * const fasa = new FasaApi({
 *   baseUrl: 'https://serviciocrm.fasa.com.pa/ords/bmw_pan',
 *   clientId: '...',
 *   clientSecret: '...',
 * });
 *
 * const marcas = await fasa.getMarcas();
 * const modelos = await fasa.getModelos('1');
 * const precio  = await fasa.getPrecio('1', '21DM', 'M SPORT', 2027);
 */
class FasaApi {
  /**
   * @param {Object} config
   * @param {string} config.baseUrl - Base ORDS (sin barra final), p.ej. https://serviciocrm.fasa.com.pa/ords/bmw_pan
   * @param {string} config.clientId - client_id de OAuth entregado por FASA
   * @param {string} config.clientSecret - client_secret de OAuth entregado por FASA
   */
  constructor({ baseUrl, clientId, clientSecret } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!clientId) throw new Error('clientId is required');
    if (!clientSecret) throw new Error('clientSecret is required');

    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    // Cache del token en las variables del script: sobrevive entre requests del
    // endpoint, así no pedimos un token OAuth nuevo por cada click del usuario.
    this.tokenKey = `fasa-token-${typeof env !== 'undefined' ? env : 'local'}`;

    this.isServerEnvironment =
      typeof setVariable === 'function' && typeof variables !== 'undefined';

    if (this.isServerEnvironment) {
      const found = (variables || []).find((v) => v.key === this.tokenKey);
      try {
        this.tokenValue = found && found.value ? JSON.parse(found.value) : null;
      } catch {
        this.tokenValue = null;
      }
    } else {
      this.tokenValue = null;
    }

    this.accessToken = null;
    this.authenticated = false;

    // El token vive 3600s; lo renovamos 5 min antes para no cortar a mitad de flujo.
    this.TOKEN_REFRESH_BUFFER = 5 * 60 * 1000;

    // ORDS pagina de a 25 por defecto. Con 500 el catálogo entero cabe en una
    // sola respuesta, pero igual seguimos `hasMore` por si algún día crece.
    this.PAGE_SIZE = 500;

    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: { Accept: 'application/json' },
    });
  }

  // ==========================================================================
  // AUTENTICACIÓN
  // ==========================================================================

  /**
   * base64 de un string ASCII.
   *
   * El sandbox de scripts de Prolibu NO expone `Buffer` ni `btoa`, así que el
   * header Basic se arma a mano.
   */
  static toBase64(input) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    let i = 0;

    while (i < input.length) {
      const c1 = input.charCodeAt(i++);
      const c2 = i < input.length ? input.charCodeAt(i++) : NaN;
      const c3 = i < input.length ? input.charCodeAt(i++) : NaN;

      const e1 = c1 >> 2;
      const e2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4);
      const e3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6);
      const e4 = isNaN(c3) ? 64 : c3 & 63;

      out += CHARS.charAt(e1) + CHARS.charAt(e2)
        + (e3 === 64 ? '=' : CHARS.charAt(e3))
        + (e4 === 64 ? '=' : CHARS.charAt(e4));
    }

    return out;
  }

  get basicAuthHeader() {
    return `Basic ${FasaApi.toBase64(`${this.clientId}:${this.clientSecret}`)}`;
  }

  isTokenValid() {
    if (!this.tokenValue || !this.tokenValue.access_token || !this.tokenValue.cached_at) {
      return false;
    }

    const lifetimeMs = (Number(this.tokenValue.expires_in) || 3600) * 1000;
    const expiresAt = Number(this.tokenValue.cached_at) + lifetimeMs;

    return Date.now() < expiresAt - this.TOKEN_REFRESH_BUFFER;
  }

  async authenticate() {
    try {
      if (this.isTokenValid()) {
        this.accessToken = this.tokenValue.access_token;
        this.authenticated = true;
        this.updateAxiosHeaders();
        return this.accessToken;
      }

      return await this.refreshToken();
    } catch (err) {
      await this.clearTokenCache();
      throw new Error(`FASA authentication failed: ${err.message}`);
    }
  }

  async refreshToken() {
    try {
      const response = await axios.post(
        `${this.baseUrl}/oauth/token`,
        'grant_type=client_credentials',
        {
          headers: {
            Authorization: this.basicAuthHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          timeout: 30000,
        },
      );

      const tokenResponse = { ...response.data, cached_at: Date.now() };

      if (this.isServerEnvironment) {
        await setVariable(this.tokenKey, JSON.stringify(tokenResponse));
      }

      this.tokenValue = tokenResponse;
      this.accessToken = tokenResponse.access_token;
      this.authenticated = true;
      this.updateAxiosHeaders();

      console.log(`🔑 FASA token renovado (expira en ${tokenResponse.expires_in}s)`);
      return this.accessToken;
    } catch (err) {
      const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
      throw new Error(`FASA token refresh failed: ${detail}`);
    }
  }

  async clearTokenCache() {
    try {
      if (this.isServerEnvironment) await setVariable(this.tokenKey, '');
    } catch (err) {
      console.log('Warning: no se pudo limpiar el cache del token FASA:', err.message);
    }

    this.tokenValue = null;
    this.accessToken = null;
    this.authenticated = false;
    delete this.axios.defaults.headers.Authorization;
  }

  updateAxiosHeaders() {
    if (this.accessToken) {
      this.axios.defaults.headers.Authorization = `Bearer ${this.accessToken}`;
    }
  }

  // ==========================================================================
  // TRANSPORTE
  // ==========================================================================

  /**
   * GET a un recurso ORDS siguiendo la paginación (`hasMore` + `offset`) hasta
   * agotar la colección. Devuelve el array `items` completo.
   *
   * Reintenta una vez ante un 401: el token pudo haberse invalidado del lado de
   * FASA antes de su expiración nominal.
   */
  async fetchAll(path, { retryOnAuthError = true } = {}) {
    await this.authenticate();

    const items = [];
    let offset = 0;

    for (;;) {
      let payload;

      try {
        const sep = path.includes('?') ? '&' : '?';
        const response = await this.axios.get(`${path}${sep}limit=${this.PAGE_SIZE}&offset=${offset}`);
        payload = response.data;
      } catch (err) {
        if (err.response && err.response.status === 401 && retryOnAuthError) {
          console.log('🔑 FASA devolvió 401, renovando token y reintentando...');
          await this.clearTokenCache();
          return this.fetchAll(path, { retryOnAuthError: false });
        }
        if (err.response && err.response.status === 404) return [];
        throw err;
      }

      const batch = Array.isArray(payload && payload.items) ? payload.items : [];
      items.push(...batch);

      if (!payload || !payload.hasMore || batch.length === 0) break;
      offset += batch.length;
    }

    return items;
  }

  // ==========================================================================
  // NORMALIZACIÓN
  // ==========================================================================

  /**
   * Los textos de Gensys llegan con espacios de relleno (`"  M2"`) y
   * `codigo_marca` viaja como texto en /Marcas y como número en el resto
   * (§05 de la guía de integración). Normalizamos ambas cosas de este lado para
   * que el consumidor no tenga que adivinar.
   */
  static clean(value) {
    return typeof value === 'string' ? value.trim() : value;
  }

  static normalizeRow(row) {
    const out = {};
    for (const key of Object.keys(row || {})) out[key] = FasaApi.clean(row[key]);
    if (out.codigo_marca !== undefined && out.codigo_marca !== null) {
      out.codigo_marca = String(out.codigo_marca);
    }
    return out;
  }

  static normalizeRows(rows) {
    return (rows || []).map(FasaApi.normalizeRow);
  }

  /** Un segmento de ruta puede traer espacios (grado = "M SPORT") → §03. */
  static seg(value) {
    return encodeURIComponent(String(value === undefined || value === null ? '' : value).trim());
  }

  // ==========================================================================
  // CATÁLOGO
  // ==========================================================================

  /** Marcas disponibles: BMW, MINI, BMW MOTOS. */
  async getMarcas() {
    return FasaApi.normalizeRows(await this.fetchAll('/FasaCrm/Marcas'));
  }

  /** Modelos de una marca. */
  async getModelos(codigoMarca) {
    return FasaApi.normalizeRows(
      await this.fetchAll(`/FasaCrm/modelos/${FasaApi.seg(codigoMarca)}`),
    );
  }

  /** Grados/acabados de un modelo. */
  async getGrados(codigoMarca, codigoModelo) {
    return FasaApi.normalizeRows(
      await this.fetchAll(`/FasaCrm/grados/${FasaApi.seg(codigoMarca)}/${FasaApi.seg(codigoModelo)}`),
    );
  }

  /** Años disponibles para marca/modelo/grado. */
  async getAnios(codigoMarca, codigoModelo, grado) {
    return FasaApi.normalizeRows(
      await this.fetchAll(
        `/FasaCrm/anios/${FasaApi.seg(codigoMarca)}/${FasaApi.seg(codigoModelo)}/${FasaApi.seg(grado)}`,
      ),
    );
  }

  /** Precios de lista de la combinación exacta (normalmente una sola fila). */
  async getPrecios(codigoMarca, codigoModelo, grado, anio) {
    return FasaApi.normalizeRows(
      await this.fetchAll(
        `/FasaCrm/precios/${FasaApi.seg(codigoMarca)}/${FasaApi.seg(codigoModelo)}/${FasaApi.seg(grado)}/${FasaApi.seg(anio)}`,
      ),
    );
  }

  /** Precio de lista único (primera fila) o `null` si FASA no publica precio. */
  async getPrecio(codigoMarca, codigoModelo, grado, anio) {
    const rows = await this.getPrecios(codigoMarca, codigoModelo, grado, anio);
    return rows.length ? rows[0] : null;
  }

  /** Especificaciones/equipamiento de la combinación exacta. */
  async getEspecificaciones(codigoMarca, codigoModelo, grado, anio) {
    return FasaApi.normalizeRows(
      await this.fetchAll(
        `/FasaCrm/especificaciones/${FasaApi.seg(codigoMarca)}/${FasaApi.seg(codigoModelo)}/${FasaApi.seg(grado)}/${FasaApi.seg(anio)}`,
      ),
    );
  }

  /**
   * Precio + especificaciones en una sola llamada: es lo que necesita la ficha
   * del vehículo, y así el navegador hace un request en vez de dos.
   */
  async getFicha(codigoMarca, codigoModelo, grado, anio) {
    const [precio, especificaciones] = await Promise.all([
      this.getPrecio(codigoMarca, codigoModelo, grado, anio),
      this.getEspecificaciones(codigoMarca, codigoModelo, grado, anio),
    ]);

    return { precio, especificaciones };
  }

  // ==========================================================================
  // RESERVAS
  // ==========================================================================

  /**
   * Detalle completo de una reserva/venta por el par (número de pedido, número
   * de auto) — los mismos dos códigos que el Deal guarda en `gensysCodigos`.
   *
   * Devuelve el registro ya normalizado, o `null` si no existe. `fetchAll`
   * traduce el 404 de ORDS a `[]`, así que "no encontrada" y "colección vacía"
   * llegan acá de la misma forma y se colapsan en `null`.
   *
   * ⚠️ La respuesta trae **PII del cliente** (nombre, celular, email, ciudad,
   * dirección). Tratarla con el mismo cuidado que en el origen: no loguearla,
   * no devolverla a un consumidor que no deba verla (§ DOC-FASA-PROLIBU-2026-001).
   *
   * @param {string|number} numeroPedido
   * @param {string|number} numeroAuto
   * @returns {Promise<Object|null>}
   */
  async getReserva(numeroPedido, numeroAuto) {
    const rows = await this.fetchAll(
      `/FasaCrm/reserva/${FasaApi.seg(numeroPedido)}/${FasaApi.seg(numeroAuto)}`,
    );
    if (!rows.length) return null;
    return FasaApi.normalizeRow(rows[0]);
  }
}

// El sandbox no expone `module`, pero los tests locales sí lo necesitan.
try {
  module.exports = FasaApi;
} catch { /* sandbox de Prolibu: sin module */ }
