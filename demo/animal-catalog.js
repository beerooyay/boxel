// Both the player and the free-roaming animals use these world scales.
export const animals = [
  ['Fox', 'Fox', 0.32], ['Deer', 'Deer', 0.35], ['Stag', 'Stag', 0.38],
  ['Wolf', 'Wolf', 0.35], ['Husky', 'Husky', 0.28], ['ShibaInu', 'Shiba Inu', 0.24],
  ['Alpaca', 'Alpaca', 0.35], ['Bull', 'Bull', 0.38], ['Cow', 'Cow', 0.37],
  ['Donkey', 'Donkey', 0.37], ['Horse', 'Horse', 0.42], ['Horse_White', 'White horse', 0.41],
].map(([id, label, scale]) => ({ id, label, scale,
  url: new URL(id === 'Fox' ? './fox.glb' : './animals/' + id + '.glb', import.meta.url) }));

export function animalById(id) {
  return animals.find(animal => animal.id === id);
}
