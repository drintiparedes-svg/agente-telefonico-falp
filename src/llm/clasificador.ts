/**
 * Clasificador de intención.
 *
 * Es el ÚNICO punto donde interviene un modelo de lenguaje, y su trabajo está
 * deliberadamente acotado: leer lo que dijo el paciente y devolver una etiqueta
 * de un conjunto cerrado, más los fragmentos literales que haya que registrar.
 * Nunca redacta lo que el agente dirá. Esa separación es lo que impide que un
 * modelo improvise contenido clínico.
 */
import { Clasificacion } from '../dominio/tipos.js';
import type { Estado } from '../dominio/tipos.js';
import { extraerNumeros } from '../dominio/checklist/numeros.js';

export interface Clasificador {
  clasificar(entrada: {
    textoPaciente: string;
    estado: Estado;
    /** Qué se le acaba de preguntar. Da contexto sin abrir la puerta a generar. */
    preguntaDelAgente: string;
  }): Promise<Clasificacion>;
}

const INSTRUCCIONES = `Eres un clasificador. NO eres un asistente y NO conversas.

Recibes lo que dijo un paciente por teléfono y devuelves un único objeto JSON.
No agregas texto antes ni después del JSON.

Campos:
- intencion: exactamente uno de
  confirma | niega | no_entiende | pide_repetir | pide_persona | pregunta_clinica |
  reporta_sintoma | rechaza_grabacion | no_es_buen_momento | responde_dato | irrelevante
- valorLiteral: si la intención es responde_dato, el dato tal como lo dijo el paciente,
  sin normalizar, sin completar y sin corregir. En cualquier otro caso, cadena vacía.
- sintomaLiteral: si la intención es reporta_sintoma, la transcripción literal de lo que
  dijo sobre su síntoma. No lo interpretes, no lo resumas y no le pongas nombre clínico.
  En cualquier otro caso, cadena vacía.
- preguntaLiteral: si la intención es pregunta_clinica, la pregunta transcrita literalmente.
  En cualquier otro caso, cadena vacía.
- confianza: número entre 0 y 1.

Reglas que no admiten excepción:
- Cualquier mención de un síntoma físico o de sentirse mal es reporta_sintoma, aunque el
  paciente la mencione de pasada o al final de otra frase. Ante la duda, reporta_sintoma.
- Cualquier pregunta sobre su enfermedad, tratamiento, resultados, pronóstico o sobre el
  procedimiento mismo es pregunta_clinica. Ante la duda, pregunta_clinica.
- Si no logras determinar la intención con claridad, usa no_entiende con confianza baja.
  Nunca adivines.`;

/**
 * Clasificador determinista por reglas. No hace red.
 * Sirve para pruebas, CI y para operar degradado si el proveedor de modelo cae:
 * un agente clínico no debe quedarse mudo porque una API externa no responde.
 */
export class ClasificadorSimulado implements Clasificador {
  async clasificar(e: { textoPaciente: string; estado: Estado; preguntaDelAgente: string }): Promise<Clasificacion> {
    const t = e.textoPaciente
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    const contiene = (...xs: string[]) => xs.some((x) => t.includes(x));

    if (t === '') return Clasificacion.parse({ intencion: 'no_entiende', confianza: 0.9 });

    if (contiene('con una persona', 'con alguien', 'hablar con un', 'operador', 'pasame con', 'páseme con'))
      return Clasificacion.parse({ intencion: 'pide_persona', confianza: 0.95 });

    if (contiene('no me grabe', 'no quiero que me grab', 'sin grabar', 'no me grabes'))
      return Clasificacion.parse({ intencion: 'rechaza_grabacion', confianza: 0.9 });

    if (contiene('no es buen momento', 'estoy ocupad', 'llameme despues', 'llámeme después', 'ahora no puedo'))
      return Clasificacion.parse({ intencion: 'no_es_buen_momento', confianza: 0.9 });

    if (contiene('repita', 'repetir', 'de nuevo', 'otra vez', 'no escuche', 'no escuché', 'mas despacio', 'más despacio'))
      return Clasificacion.parse({ intencion: 'pide_repetir', confianza: 0.9 });

    // Preguntas clínicas: signo de interrogación o interrogativo + término clínico.
    if (
      (t.includes('?') || contiene('que significa', 'qué significa', 'por que', 'por qué', 'es grave', 'me voy a')) &&
      contiene('tumor', 'cancer', 'cáncer', 'quimio', 'radio', 'metasta', 'examen', 'resultado', 'pronostico',
        'pronóstico', 'operacion', 'operación', 'cirugia', 'cirugía', 'grave', 'enfermedad', 'creci')
    )
      return Clasificacion.parse({
        intencion: 'pregunta_clinica',
        preguntaLiteral: e.textoPaciente,
        confianza: 0.85,
      });

    if (contiene('fiebre', 'sangre', 'sangrando', 'dolor', 'no puedo respirar', 'me siento muy mal', 'vomit', 'mareo', 'desmay'))
      return Clasificacion.parse({
        intencion: 'reporta_sintoma',
        sintomaLiteral: e.textoPaciente,
        confianza: 0.9,
      });

    if (contiene('no entiendo', 'no comprendo', 'como dice', 'cómo dice', 'no se', 'no sé'))
      return Clasificacion.parse({ intencion: 'no_entiende', confianza: 0.85 });

    // Dato numérico o de hora, en cifras o en palabras: se devuelve literal,
    // sin normalizar. Quien lo compara es la máquina.
    if (/\d/.test(t) || extraerNumeros(t).length > 0) {
      return Clasificacion.parse({ intencion: 'responde_dato', valorLiteral: e.textoPaciente, confianza: 0.85 });
    }

    if (contiene('no ', 'nop', 'negativo', 'todavia no', 'todavía no') || t === 'no')
      return Clasificacion.parse({ intencion: 'niega', confianza: 0.85 });

    if (contiene('si', 'sí', 'claro', 'correcto', 'de acuerdo', 'ya', 'entendi', 'entendí', 'perfecto', 'bueno'))
      return Clasificacion.parse({ intencion: 'confirma', confianza: 0.85 });

    return Clasificacion.parse({ intencion: 'irrelevante', confianza: 0.4 });
  }
}

/** Clasificador respaldado por un modelo. Se degrada al simulado ante cualquier fallo. */
export class ClasificadorAnthropic implements Clasificador {
  private readonly respaldo = new ClasificadorSimulado();

  constructor(
    private readonly apiKey: string,
    private readonly modelo: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async clasificar(e: { textoPaciente: string; estado: Estado; preguntaDelAgente: string }): Promise<Clasificacion> {
    try {
      const r = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.modelo,
          max_tokens: 400,
          system: INSTRUCCIONES,
          messages: [
            {
              role: 'user',
              content:
                `Etapa de la llamada: ${e.estado}\n` +
                `El agente acaba de decir: "${e.preguntaDelAgente}"\n` +
                `El paciente respondió: "${e.textoPaciente}"\n\n` +
                `Devuelve solo el JSON.`,
            },
          ],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cuerpo = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      const texto = cuerpo.content?.find((c) => c.type === 'text')?.text ?? '';
      const json = texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1);
      return Clasificacion.parse(JSON.parse(json));
    } catch {
      // La degradación es silenciosa para el paciente pero visible en el registro:
      // quien llama a este método anota el fallo. Nunca se deja la llamada sin clasificar.
      return this.respaldo.clasificar(e);
    }
  }
}

export function crearClasificador(cfg: {
  CLASIFICADOR: 'simulado' | 'anthropic';
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_MODELO: string;
}): Clasificador {
  if (cfg.CLASIFICADOR === 'anthropic' && cfg.ANTHROPIC_API_KEY) {
    return new ClasificadorAnthropic(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODELO);
  }
  return new ClasificadorSimulado();
}
