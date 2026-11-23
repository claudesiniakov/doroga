import { buildCar, type CarConfig } from './car';
import { buildKedr } from './car-kedr';
import { buildVan } from './car-van';
import { buildVette } from './car-vette';

export function buildPlayerCar(config: CarConfig) {
  switch (config.body) {
    case 'suv': return buildKedr(config);
    case 'van': return buildVan(config);
    case 'vette': return buildVette({ ...config, sponsor: 'absolutins.ru' });
    default: return buildCar(config);
  }
}
