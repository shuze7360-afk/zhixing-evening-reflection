import { useState } from 'react';
import { Sidebar, type PageId } from './components/Sidebar';
import { NavContext } from './components/nav';
import { ThemeSwitch } from './components/ThemeSwitch';
import { TonightReviewPage } from './pages/TonightReviewPage';
import { DialogPage } from './pages/DialogPage';
import { RecordsPage } from './pages/RecordsPage';
import { ExperimentsPage } from './pages/ExperimentsPage';
import { PrinciplesPage } from './pages/PrinciplesPage';
import { GrowthPage } from './pages/GrowthPage';
import { SettingsPage } from './pages/SettingsPage';

const PAGES: Record<PageId, () => React.JSX.Element> = {
  tonight: TonightReviewPage,
  dialog: DialogPage,
  records: RecordsPage,
  experiments: ExperimentsPage,
  principles: PrinciplesPage,
  growth: GrowthPage,
  settings: SettingsPage,
};

export default function App() {
  const [active, setActive] = useState<PageId>('tonight');
  const Page = PAGES[active];

  return (
    <NavContext.Provider value={setActive}>
      <div className="flex h-screen bg-bg text-ink">
        <Sidebar active={active} onNavigate={setActive} footer={<ThemeSwitch />} />
        <main className="flex-1 overflow-y-auto">
          <Page />
        </main>
      </div>
    </NavContext.Provider>
  );
}
