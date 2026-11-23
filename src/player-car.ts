import { buildCar, type CarConfig } from './car';
import { buildKedr } from './car-kedr';
import { buildVan } from './car-van';
import { buildVette } from './car-vette';
import { TrafficAssets } from './traffic-models';

export function buildPlayerCar(config: CarConfig) {
  switch (config.body) {
    case 'suv': return buildKedr(config);
    case 'van': return buildVan(config);
    case 'vette': return buildVette({ ...config, sponsor: 'absolutins.ru' });
    case 'classic': return new TrafficAssets().createClassicPlayer(config);
    default: return buildCar(config);
  }
}
