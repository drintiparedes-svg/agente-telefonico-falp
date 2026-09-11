import { ContextoLlamada, type Clasificacion } from '../src/dominio/tipos.js';

export const contexto = ContextoLlamada.parse({
  idLlamada: 'llam-001',
  idPaciente: 'pac-001',
  verificacion: {
    nombrePaciente: 'María',
    rutUltimosCuatro: '4821',
    diaMesProcedimiento: '15-04',
  },
  indicacion: {
    idIndicacion: 'ind-77',
    emitidaPor: 'Dra. Silva',
    emitidaEn: '2026-04-10T14:00:00.000Z',
    horaInicioAyuno: '22:00',
    farmacosASuspender: [
      { nombre: 'acenocumarol', instruccion: 'Debe suspender el acenocumarol desde el lunes en la mañana, es decir, tres días antes.' },
      { nombre: 'aspirina', instruccion: 'La aspirina la suspende el mismo lunes.' },
    ],
    examenesRequeridos: ['hemograma', 'perfil de coagulación'],
    requiereAcompanante: true,
    horaLlegada: '07:30',
    fechaProcedimiento: '2026-04-15',
  },
});

export function cls(p: Partial<Clasificacion> & { intencion: Clasificacion['intencion'] }): Clasificacion {
  return {
    valorLiteral: '',
    sintomaLiteral: '',
    preguntaLiteral: '',
    confianza: 0.9,
    ...p,
  };
}
