/*
 * channel-icons.ts — the ready-made icons a channel can use instead of an
 * uploaded picture, all white line drawings on black.
 *
 * Each is a single SVG path on a 24×24 grid, drawn as an outline. The edit
 * dialog (components/ChannelEditDialog.tsx) shows them as SVG; choosing one
 * paints it onto a canvas here and uploads the result as an ordinary JPEG, so
 * the server treats it exactly like a picture someone uploaded.
 */

export interface ChannelIcon {
  id: string;
  label: string;
  path: string;
}

export const CHANNEL_ICONS: ChannelIcon[] = [
  { id: 'clock', label: 'Clock (watch later)', path: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3.5 2' },
  {
    id: 'folder',
    label: 'Folder',
    path: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  },
  { id: 'star', label: 'Star', path: 'M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7Z' },
  {
    id: 'heart',
    label: 'Heart',
    path: 'M12 20.5S3.5 15.4 3.5 9.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.4c0 6-8.5 11.1-8.5 11.1Z',
  },
  { id: 'bookmark', label: 'Bookmark', path: 'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Z' },
  {
    id: 'music',
    label: 'Music',
    path: 'M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0M19 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  },
  { id: 'film', label: 'Film', path: 'M4 4h16v16H4ZM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4' },
  {
    id: 'tv',
    label: 'Television',
    path: 'M4 7h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM8 3l4 4 4-4',
  },
  { id: 'play', label: 'Play', path: 'M8 5l11 7-11 7Z' },
  {
    id: 'game',
    label: 'Games',
    path: 'M7 8h10a4.5 4.5 0 0 1 4.4 5.4l-.7 3.4a2.4 2.4 0 0 1-4.2 1L14.5 15.5h-5L7.5 17.8a2.4 2.4 0 0 1-4.2-1l-.7-3.4A4.5 4.5 0 0 1 7 8ZM7.5 10.5v3M6 12h3M15.5 11h.01M18 13h.01',
  },
  {
    id: 'book',
    label: 'Book',
    path: 'M12 6.5C10 5 7 4.5 3 5v14c4-.5 7 0 9 1.5c2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5ZM12 6.5v14',
  },
  {
    id: 'mic',
    label: 'Microphone',
    path: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6',
  },
  {
    id: 'camera',
    label: 'Camera',
    path: 'M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM12 9.5a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  },
  {
    id: 'globe',
    label: 'Globe',
    path: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3 2.5 4 5.5 4 9s-1 6.5-4 9c-3-2.5-4-5.5-4-9s1-6.5 4-9Z',
  },
  {
    id: 'idea',
    label: 'Light bulb',
    path: 'M9 17v-1c0-.9-.4-1.5-1.1-2.1a6.5 6.5 0 1 1 8.2 0c-.7.6-1.1 1.2-1.1 2.1v1ZM10 20.5h4',
  },
  {
    id: 'learn',
    label: 'Learning',
    path: 'M2.5 9.5L12 5l9.5 4.5L12 14ZM6.5 11.5v5c0 1 2.5 2.5 5.5 2.5s5.5-1.5 5.5-2.5v-5M21.5 9.5v6',
  },
  { id: 'flag', label: 'Flag', path: 'M5 21V4M5 4c4-2 7 2 14 0v10c-7 2-10-2-14 0' },
  { id: 'home', label: 'Home', path: 'M3.5 11.5L12 4l8.5 7.5M6 9.5V20h12V9.5M10 20v-6h4v6' },
  { id: 'code', label: 'Code', path: 'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14' },
  {
    id: 'rocket',
    label: 'Rocket',
    path: 'M12 2.5c3.5 3 4.5 7 4 12H8c-.5-5 .5-9 4-12ZM8 11l-3 4v3l3.5-1.5M16 11l3 4v3l-3.5-1.5M10 17.5v3M14 17.5v3M12 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
  },
];

/** Paints an icon, white on black, as a square JPEG ready to upload. */
export function renderChannelIcon(icon: ChannelIcon, size = 512): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('This browser cannot draw the icon'));

  context.fillStyle = '#000000';
  context.fillRect(0, 0, size, size);

  // The drawing fills the middle of the square, leaving room for a round crop.
  const scale = (size * 0.62) / 24;
  context.translate((size - 24 * scale) / 2, (size - 24 * scale) / 2);
  context.scale(scale, scale);
  context.strokeStyle = '#ffffff';
  context.lineWidth = 1.6;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.stroke(new Path2D(icon.path));

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('This browser cannot draw the icon'))),
      'image/jpeg',
      0.92,
    );
  });
}
