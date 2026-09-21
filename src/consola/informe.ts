/**
 * Informe tabulado de una llamada, para el equipo que la programó y la revisa.
 *
 * Reúne en una sola vista lo que hoy está repartido en tres tablas: el trabajo
 * (a quién se llamó y cuándo), el resultado (criterios y datos) y la auditoría
 * (transición por transición, con lo que dijo el paciente). Y agrega lo que
 * una persona completó después. Cuatro bloques:
 *
 *   educación    qué bloques del checklist se entregaron y cuáles se confirmaron
 *   protocolo    los criterios del protocolo, cumplidos o no, con justificación
 *   transcripción  los turnos de la llamada, literales
 *   faltantes    lo que quedó sin confirmar, y quién lo completó a mano si alguien lo hizo
 *
 * Nada se recalcula: los veredictos son los que dejó la evaluación determinista.
 * Una anotación humana se muestra junto al dato original, nunca en su lugar.
 */
import type { EventoAuditoria } from '../dominio/tipos.js';
import type { ResultadoLlamada } from '../dominio/criterios/index.js';
import type { Anotacion, CampoAnotable, Trabajo } from '../persistencia/repositorios.js';
import { resumirLlamada, type EstadoResumen } from '../api/estado-llamada.js';

export interface BloqueEducacion {
  bloque: string;
  titulo: string;
  /** El agente pronunció la línea de este bloque. */
  entregado: boolean;
  /** El paciente lo confirmó según la regla de ese bloque. */
  confirmado: 'si' | 'no' | 'indeterminado';
  detalle: string;
}

export interface CriterioInforme {
  id: string;
  titulo: string;
  veredicto: ResultadoLlamada['criterios'][number]['veredicto'];
  justificacion: string;
}

export interface Turno {
  ts: string;
  paciente: string;
  agente: string;
  estado: string;
  guardrail: string | null;
}

export interface Faltante {
  campo: CampoAnotable | 'verificacion_manual';
  descripcion: string;
  completado: { valor: string; nota: string; autor: string; creadoEn: string } | null;
}

export interface InformeLlamada {
  id: string;
  idPaciente: string;
  nombre: string;
  telefono: string;
  servicio: string;
  fechaProcedimiento: string;
  emitidaPor: string;
  estado: EstadoResumen;
  detalle: string;
  programadaPara: string;
  creadaEn: string;
  estadoFinal: string | null;
  resumen: string;
  educacion: BloqueEducacion[];
  protocolo: {
    cumplido: boolean;
    cumplidos: number;
    total: number;
    requiereRevision: boolean;
    revisadoEn: string | null;
    criterios: CriterioInforme[];
  };
  transcripcion: Turno[];
  faltantes: Faltante[];
  anotaciones: Anotacion[];
}

export const TITULO_CRITERIO: Record<string, string> = {
  identidad_verificada: 'Identidad verificada con dos factores',
  divulgacion_realizada: 'Divulgación de sistema automatizado y grabación',
  ayuno_comprendido: 'Ayuno comprendido (hora repetida)',
  farmacos_confirmados: 'Fármacos confirmados uno a uno',
  examenes_verificados: 'Exámenes verificados',
  logistica_confirmada: 'Hora de llegada y acompañante confirmados',
  sin_generacion_clinica: 'Sin contenido clínico generado',
  alarma_gestionada: 'Síntoma de alarma gestionado',
};

export const TITULO_FALTANTE: Record<Faltante['campo'], string> = {
  acompanante_confirmado: 'Acompañante',
  examenes_faltantes: 'Exámenes',
  farmacos_no_confirmados: 'Fármacos',
  hora_ayuno_repetida: 'Hora de ayuno',
  educacion_reforzada: 'Educación reforzada',
  contacto_manual: 'Contacto manual',
  telefono_alternativo: 'Teléfono alternativo',
  observacion: 'Observación',
  verificacion_manual: 'Verificación manual',
};

export function armarInforme(
  t: Trabajo & { creadoEn: string; actualizadoEn: string },
  r: (ResultadoLlamada & { creadoEn: string; revisadoEn: string | null }) | null,
  auditoria: EventoAuditoria[],
  anotaciones: Anotacion[],
  ahora: Date = new Date(),
): InformeLlamada {
  const resumen = resumirLlamada(t, r, ahora);
  const ctx = t.contexto;
  const educacion = armarEducacion(t, r, auditoria);
  const criterios: CriterioInforme[] = (r?.criterios ?? []).map((c) => ({
    id: c.id,
    titulo: TITULO_CRITERIO[c.id] ?? c.id.replace(/_/g, ' '),
    veredicto: c.veredicto,
    justificacion: c.justificacion,
  }));
  const cumplidos = criterios.filter((c) => c.veredicto === 'cumplido').length;

  return {
    id: t.id,
    idPaciente: t.idPaciente,
    nombre: ctx.verificacion.nombrePaciente,
    telefono: t.telefono,
    servicio: ctx.servicio ?? '',
    fechaProcedimiento: ctx.indicacion.fechaProcedimiento,
    emitidaPor: ctx.indicacion.emitidaPor,
    estado: resumen.estado,
    detalle: resumen.detalle,
    programadaPara: t.programadoPara,
    creadaEn: t.creadoEn,
    estadoFinal: r?.estadoFinal ?? null,
    resumen: resumen.resultado?.resumen ?? resumen.detalle,
    educacion,
    protocolo: {
      cumplido: r !== null && criterios.length > 0 && cumplidos === criterios.length,
      cumplidos,
      total: criterios.length,
      requiereRevision: r?.requiereRevisionHumana ?? false,
      revisadoEn: r?.revisadoEn ?? null,
      criterios,
    },
    transcripcion: auditoria.map((e) => ({
      ts: e.ts,
      paciente: e.entradaPaciente,
      agente: e.salidaAgente,
      estado: e.estadoNuevo,
      guardrail: e.guardrail,
    })),
    faltantes: armarFaltantes(t, r, resumen.estado, anotaciones),
    anotaciones,
  };
}

function armarEducacion(
  t: Trabajo,
  r: ResultadoLlamada | null,
  auditoria: EventoAuditoria[],
): BloqueEducacion[] {
  const ind = t.contexto.indicacion;
  const entro = (estado: string) => auditoria.some((e) => e.estadoNuevo === estado);
  const dijo = (fragmento: string) => auditoria.some((e) => e.salidaAgente.includes(fragmento));
  const veredicto = (id: string) => r?.criterios.find((c) => c.id === id)?.veredicto ?? 'indeterminado';
  const d = r?.datos;
  const aConfirmado = (v: string): BloqueEducacion['confirmado'] => (v === 'cumplido' ? 'si' : v === 'no_cumplido' ? 'no' : 'indeterminado');

  const bloques: BloqueEducacion[] = [
    {
      bloque: 'divulgacion',
      titulo: 'Divulgación: sistema automatizado y grabación',
      entregado: entro('apertura'),
      confirmado: entro('apertura') ? 'si' : 'indeterminado',
      detalle: entro('apertura') ? 'Se informó al inicio de la llamada.' : 'La llamada no llegó a abrirse.',
    },
    {
      bloque: 'identidad',
      titulo: 'Verificación de identidad',
      entregado: entro('verificacion_identidad'),
      confirmado: d ? (d.identidad_confirmada ? 'si' : 'no') : 'indeterminado',
      detalle: d?.identidad_confirmada ? 'Dos factores no clínicos confirmados.' : 'Sin identidad verificada no se entregó contenido clínico.',
    },
    {
      bloque: 'ayuno',
      titulo: `Ayuno desde las ${ind.horaInicioAyuno}`,
      entregado: entro('ayuno'),
      confirmado: entro('ayuno') ? (d?.hora_ayuno_repetida ? 'si' : 'no') : 'indeterminado',
      detalle: d?.hora_ayuno_repetida ? `El paciente repitió ${d.hora_ayuno_repetida}.` : entro('ayuno') ? 'El paciente no repitió la hora.' : 'No se alcanzó este bloque.',
    },
  ];

  const noConfirmados = (d?.farmacos_no_confirmados ?? '').split(';').map((x) => x.trim()).filter(Boolean);
  ind.farmacosASuspender.forEach((f, i) => {
    const entregado = dijo(f.instruccion);
    const enNoConfirmados = noConfirmados.some((n) => n.toLowerCase().includes(f.nombre.toLowerCase()) || f.instruccion.includes(n));
    bloques.push({
      bloque: `farmaco:${i + 1}`,
      titulo: `Fármaco: ${f.nombre}`,
      entregado,
      confirmado: !entregado ? 'indeterminado' : enNoConfirmados ? 'no' : veredicto('farmacos_confirmados') === 'cumplido' || entro('examenes') || entro('logistica') || r?.estadoFinal === 'terminada_ok' ? 'si' : 'indeterminado',
      detalle: entregado ? `Se leyó la instrucción literal: «${f.instruccion}»` : 'No se alcanzó este fármaco.',
    });
  });
  if (ind.farmacosASuspender.length === 0) {
    bloques.push({ bloque: 'farmacos', titulo: 'Fármacos', entregado: dijo('no hay medicamentos que suspender'), confirmado: 'si', detalle: 'La indicación no contempla fármacos a suspender.' });
  }

  bloques.push({
    bloque: 'examenes',
    titulo: ind.examenesRequeridos.length > 0 ? `Exámenes: ${ind.examenesRequeridos.join(', ')}` : 'Exámenes',
    entregado: entro('examenes'),
    confirmado: entro('examenes') ? (d?.examenes_faltantes ? 'no' : aConfirmado(veredicto('examenes_verificados'))) : 'indeterminado',
    detalle: d?.examenes_faltantes ? `Faltan: ${d.examenes_faltantes}` : entro('examenes') ? (ind.examenesRequeridos.length > 0 ? 'El paciente declaró tenerlos.' : 'No requiere exámenes.') : 'No se alcanzó este bloque.',
  });
  bloques.push({
    bloque: 'logistica',
    titulo: `Llegada a las ${ind.horaLlegada}${ind.requiereAcompanante ? ' con acompañante' : ''}`,
    entregado: entro('logistica'),
    confirmado: entro('logistica') ? aConfirmado(veredicto('logistica_confirmada')) : 'indeterminado',
    detalle: !entro('logistica') ? 'No se alcanzó este bloque.' : ind.requiereAcompanante ? (d?.acompanante_confirmado ? 'Acompañante confirmado.' : 'Acompañante no confirmado.') : 'Hora de llegada comunicada.',
  });
  // El estado terminal vive en el resultado; la auditoría registra la línea de
  // cierre bajo el estado «cierre».
  const cerro = r?.estadoFinal === 'terminada_ok';
  bloques.push({
    bloque: 'cierre',
    titulo: 'Cierre del checklist',
    entregado: cerro || entro('cierre'),
    confirmado: cerro ? 'si' : 'indeterminado',
    detalle: cerro ? 'El checklist se completó.' : r ? `La llamada terminó en ${r.estadoFinal.replace(/_/g, ' ')}.` : 'Sin resultado.',
  });
  return bloques;
}

function armarFaltantes(
  t: Trabajo,
  r: ResultadoLlamada | null,
  estado: EstadoResumen,
  anotaciones: Anotacion[],
): Faltante[] {
  const ultima = (campo: Faltante['campo']) => {
    const a = [...anotaciones].reverse().find((x) => x.campo === campo);
    return a ? { valor: a.valor, nota: a.nota, autor: a.autor, creadoEn: a.creadoEn } : null;
  };
  const out: Faltante[] = [];
  const ind = t.contexto.indicacion;
  const d = r?.datos;

  if (!r || estado === 'sin_resultado' || estado === 'fallida') {
    out.push({
      campo: 'contacto_manual',
      descripcion: estado === 'fallida' ? 'La llamada no se estableció. Hay que contactar al paciente por otra vía.' : 'No hay resultado de la llamada. Hay que verificar la preparación con el paciente.',
      completado: ultima('contacto_manual'),
    });
    return out;
  }

  if (!d!.identidad_confirmada) {
    out.push({ campo: 'contacto_manual', descripcion: 'No se verificó la identidad y no se entregó ninguna indicación. Contactar al paciente.', completado: ultima('contacto_manual') });
  }
  if (d!.identidad_confirmada && !d!.hora_ayuno_repetida) {
    out.push({ campo: 'hora_ayuno_repetida', descripcion: `El paciente no repitió la hora de ayuno (${ind.horaInicioAyuno}).`, completado: ultima('hora_ayuno_repetida') });
  }
  if (d!.farmacos_no_confirmados) {
    out.push({ campo: 'farmacos_no_confirmados', descripcion: `Sin confirmar: ${d!.farmacos_no_confirmados}.`, completado: ultima('farmacos_no_confirmados') });
  } else if (d!.identidad_confirmada && ind.farmacosASuspender.length > 0 && r!.criterios.find((c) => c.id === 'farmacos_confirmados')?.veredicto !== 'cumplido') {
    out.push({ campo: 'farmacos_no_confirmados', descripcion: 'No se alcanzó a confirmar todos los fármacos.', completado: ultima('farmacos_no_confirmados') });
  }
  if (d!.examenes_faltantes) {
    out.push({ campo: 'examenes_faltantes', descripcion: `El paciente declaró que le faltan: ${d!.examenes_faltantes}.`, completado: ultima('examenes_faltantes') });
  } else if (d!.identidad_confirmada && ind.examenesRequeridos.length > 0 && r!.criterios.find((c) => c.id === 'examenes_verificados')?.veredicto === 'indeterminado') {
    out.push({ campo: 'examenes_faltantes', descripcion: 'No se alcanzó a verificar los exámenes.', completado: ultima('examenes_faltantes') });
  }
  if (ind.requiereAcompanante && d!.identidad_confirmada && !d!.acompanante_confirmado) {
    out.push({ campo: 'acompanante_confirmado', descripcion: 'El procedimiento requiere acompañante y el paciente no lo confirmó.', completado: ultima('acompanante_confirmado') });
  }
  if (d!.sintomas_alarma_mencionados || d!.consulta_fuera_de_guion || d!.solicito_persona) {
    out.push({ campo: 'contacto_manual', descripcion: 'La llamada pasó a una persona del equipo. Registrar qué se resolvió.', completado: ultima('contacto_manual') });
  }
  if (r!.estadoFinal === 'terminada_rechazo' || r!.estadoFinal === 'terminada_buzon') {
    out.push({ campo: 'contacto_manual', descripcion: 'No se entregó la preparación. Reprogramar o contactar por otra vía.', completado: ultima('contacto_manual') });
  }
  return out;
}

/** Fila compacta para la tabla de la consola y para la planilla exportada. */
export interface FilaInforme {
  id: string;
  idPaciente: string;
  nombre: string;
  telefono: string;
  servicio: string;
  fechaProcedimiento: string;
  emitidaPor: string;
  creadaEn: string;
  estado: EstadoResumen;
  estadoFinal: string;
  resumen: string;
  educacionEntregada: string;
  educacionConfirmada: string;
  protocoloCumplido: string;
  criteriosCumplidos: string;
  criteriosNoCumplidos: string;
  requiereRevision: string;
  revisadoEn: string;
  faltantes: string;
  faltantesCompletados: string;
  turnos: number;
}

export function aFila(i: InformeLlamada): FilaInforme {
  const entregados = i.educacion.filter((b) => b.entregado);
  const confirmados = i.educacion.filter((b) => b.confirmado === 'si');
  const pendientes = i.faltantes.filter((f) => !f.completado);
  const completados = i.faltantes.filter((f) => f.completado);
  return {
    id: i.id,
    idPaciente: i.idPaciente,
    nombre: i.nombre,
    telefono: i.telefono,
    servicio: i.servicio,
    fechaProcedimiento: i.fechaProcedimiento,
    emitidaPor: i.emitidaPor,
    creadaEn: i.creadaEn,
    estado: i.estado,
    estadoFinal: i.estadoFinal ?? '',
    resumen: i.resumen,
    educacionEntregada: `${entregados.length}/${i.educacion.length}`,
    educacionConfirmada: `${confirmados.length}/${i.educacion.length}`,
    protocoloCumplido: i.estadoFinal === null ? '' : i.protocolo.cumplido ? 'sí' : 'no',
    criteriosCumplidos: `${i.protocolo.cumplidos}/${i.protocolo.total}`,
    criteriosNoCumplidos: i.protocolo.criterios.filter((c) => c.veredicto !== 'cumplido').map((c) => c.titulo).join('; '),
    requiereRevision: i.protocolo.requiereRevision ? 'sí' : 'no',
    revisadoEn: i.protocolo.revisadoEn ?? '',
    faltantes: pendientes.map((f) => `${TITULO_FALTANTE[f.campo]}: ${f.descripcion}`).join(' | '),
    faltantesCompletados: completados.map((f) => `${TITULO_FALTANTE[f.campo]}: ${f.completado!.valor} (${f.completado!.autor})`).join(' | '),
    turnos: i.transcripcion.length,
  };
}
