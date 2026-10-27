import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type HomeRowDto } from '../lib/api';
import { VideoRail } from '../components/VideoRail';
import { EmptyState, SkeletonGrid } from '../components/Common';

export function Home() {
  const [rows, setRows] = useState<HomeRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ rows: HomeRowDto[] }>('/api/home')
      .then((data) => {
        if (!cancelled) setRows(data.rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load your library');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="notice error">{error}</div>;
  if (!rows) return <SkeletonGrid count={8} />;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        message="No videos were found in your media folder. Check the folder path and run a scan."
        action={
          <Link className="btn primary" to="/settings">
            Open settings
          </Link>
        }
      />
    );
  }

  return (
    <div>
      {rows.map((row) => (
        <VideoRail
          key={row.id}
          title={row.title}
          items={row.items}
          channel={row.channel}
          link={row.link}
          showChannel={!row.channel}
        />
      ))}
    </div>
  );
}
