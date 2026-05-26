import { DialRoot } from 'dialkit';
import 'dialkit/styles.css';
import { Composition } from './Composition';

export default function App() {
  return (
    <>
      <Composition />
      <DialRoot position="top-right" productionEnabled />
    </>
  );
}
