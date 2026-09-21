/**
 * Tipos del dominio.
 *
 * Principio rector: la instrucción clínica NUNCA se genera. Llega desde la ficha
 * como dato ya emitido por el equipo tratante y el agente solo la comunica y
 * verifica comprensión. Ver docs/arquitectura.md y docs/cumplimiento.md.
 */
import { z } from 'zod';

/** Instrucciones de preparación, emitidas por el equipo tratante y ya registradas en ficha. */
export const IndicacionPreparacion = z.object({
  /** Identificador de la indicación en el sistema de origen. Trazabilidad. */
  idIndicacion: z.string().min(1),
  /** Profesional que emitió la indicación. Sin esto la llamada no es lícita. */
  emitidaPor: z.string().min(1),
  emitidaEn: z.string().datetime(),
  /** Hora de inicio del ayuno en formato HH:MM, 24 h. */
  horaInicioAyuno: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Fármacos a suspender, cada uno con su propia instrucción textual verificada. */
  farmacosASuspender: z
    .array(
      z.object({
        nombre: z.string().min(1),
        /** Texto exacto que el agente leerá. No se parafrasea ni se completa. */
        instruccion: z.string().min(1),
      }),
    )
    .default([]),
  examenesRequeridos: z.array(z.string().min(1)).default([]),
  requiereAcompanante: z.boolean(),
  horaLlegada: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  fechaProcedimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type IndicacionPreparacion = z.infer<typeof IndicacionPreparacion>;

/**
 * Datos de verificación de identidad. Se contrastan DOS datos no clínicos.
 * No se usa biometría de voz: activaría el art. 16 ter de la Ley 19.628 refundida
 * y exigiría consentimiento expreso adicional.
 */
export const DatosVerificacion = z.object({
  /** Nombre de pila con el que se saluda. No es un dato de verificación por sí solo. */
  nombrePaciente: z.string().min(1),
  /** Últimos cuatro dígitos del RUT sin dígito verificador. Dato no clínico. */
  rutUltimosCuatro: z.string().regex(/^\d{4}$/),
  /** Día y mes de la fecha del procedimiento, como segundo factor no clínico. */
  diaMesProcedimiento: z.string().regex(/^\d{2}-\d{2}$/),
});
export type DatosVerificacion = z.infer<typeof DatosVerificacion>;

export const ContextoLlamada = z.object({
  idLlamada: z.string().min(1),
  idPaciente: z.string().min(1),
  verificacion: DatosVerificacion,
  indicacion: IndicacionPreparacion,
  /**
   * Servicio o unidad que realiza el procedimiento (por ejemplo, endoscopía).
   * Opcional. Si viene, las transferencias se enrutan al equipo de ese servicio.
   */
  servicio: z.string().min(1).optional(),
});
export type ContextoLlamada = z.infer<typeof ContextoLlamada>;

/**
 * Motivos con que se enruta una transferencia a un destino telefónico. Conjunto
 * cerrado y más grueso que el motivo del guardrail: agrupa lo que atiende un
 * mismo equipo (ver src/telefonia/transferencias.ts).
 */
export const MOTIVOS_ENRUTAMIENTO = ['alarma', 'consulta', 'incomprension', 'fuera_de_guion'] as const;
export type MotivoEnrutamiento = (typeof MOTIVOS_ENRUTAMIENTO)[number];

/** Estados de la máquina. El orden es obligatorio y no se puede saltar. */
export const ESTADOS = [
  'apertura',
  'verificacion_identidad',
  'divulgacion',
  'ayuno',
  'farmacos',
  'examenes',
  'logistica',
  'cierre',
  'terminada_ok',
  'terminada_sin_verificar',
  'transferida_alarma',
  'transferida_consulta',
  'transferida_incomprension',
  'terminada_buzon',
  'terminada_rechazo',
] as const;
export type Estado = (typeof ESTADOS)[number];

/** Estados en los que la llamada ya no continúa. */
export const ESTADOS_TERMINALES: readonly Estado[] = [
  'terminada_ok',
  'terminada_sin_verificar',
  'transferida_alarma',
  'transferida_consulta',
  'transferida_incomprension',
  'terminada_buzon',
  'terminada_rechazo',
];

/** Estados en los que ya es lícito entregar contenido clínico. */
export const ESTADOS_CON_CONTENIDO_CLINICO: readonly Estado[] = [
  'ayuno',
  'farmacos',
  'examenes',
  'logistica',
  'cierre',
];

export type MotivoTransferencia =
  | 'sintoma_alarma'
  | 'consulta_clinica'
  | 'incomprension_reiterada'
  | 'solicitud_del_paciente'
  | 'fallo_de_datos';

/** Resultado de clasificar UNA intervención del paciente. Lo produce el LLM, acotado. */
export const Clasificacion = z.object({
  /** Qué hizo el paciente en su última intervención. */
  intencion: z.enum([
    'confirma',
    'niega',
    'no_entiende',
    'pide_repetir',
    'pide_persona',
    'pregunta_clinica',
    'reporta_sintoma',
    'rechaza_grabacion',
    'no_es_buen_momento',
    'responde_dato',
    'irrelevante',
  ]),
  /** Valor literal extraído cuando la intención es responder un dato. Sin normalizar ni inferir. */
  valorLiteral: z.string().default(''),
  /** Transcripción literal del síntoma reportado. Nunca se interpreta ni se resume. */
  sintomaLiteral: z.string().default(''),
  /** Transcripción literal de la pregunta clínica. */
  preguntaLiteral: z.string().default(''),
  /** Confianza del clasificador entre 0 y 1. Por debajo del umbral se trata como no_entiende. */
  confianza: z.number().min(0).max(1),
});
export type Clasificacion = z.infer<typeof Clasificacion>;

/** Una entrada del registro de auditoría. Cada transición deja una. */
export interface EventoAuditoria {
  idLlamada: string;
  ts: string;
  estadoAnterior: Estado;
  estadoNuevo: Estado;
  /** Por qué se transicionó. Texto legible por un revisor clínico. */
  motivo: string;
  /** Qué dijo el paciente, literal. */
  entradaPaciente: string;
  /** Qué dijo el agente, literal. */
  salidaAgente: string;
  /** Guardrail que intervino, si alguno. */
  guardrail: string | null;
}
