import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const svg = (path: ReactNode, viewBox = '0 0 24 24') =>
  function Icon(props: P) {
    return (
      <svg viewBox={viewBox} aria-hidden="true" focusable="false" {...props}>
        {path}
      </svg>
    );
  };

export const IconHome = svg(<path d="M12 3 2 11h3v10h6v-6h2v6h6V11h3L12 3z" />);
export const IconGrid = svg(
  <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />,
);
export const IconChannels = svg(
  <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5zm8.5-8a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19 14c2.8.3 5 1.9 5 4v1h-4.5v-1c0-1.5-.6-2.9-1.7-4H19z" />,
);
export const IconSettings = svg(
  <path d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.6h4l.4-2.6c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />,
);
export const IconSearch = svg(
  <path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z" />,
);
export const IconClose = svg(
  <path d="m19 6.4-1.4-1.4L12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4z" />,
);
export const IconPlay = svg(<path d="M8 5v14l11-7L8 5z" />);
export const IconPause = svg(<path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />);
export const IconVolume = svg(
  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 2.2v2.1a7.5 7.5 0 0 1 0 15.4v2.1a9.5 9.5 0 0 0 0-19.6z" />,
);
export const IconVolumeMute = svg(
  <path d="M3 9v6h4l5 5V4L7 9H3zm18.5-1.9-1.4-1.4L17 8.8l-3.1-3.1v3.1L15.6 10 17 11.4l3.1-3.1 1.4-1.2zM17 15.2l3.1 3.1 1.4-1.4-3.1-3.1 3.1-3.1-1.4-1.4L17 12.4l-1.4 1.4L17 15.2z" />,
);
export const IconFullscreen = svg(
  <path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z" />,
);
export const IconFullscreenExit = svg(
  <path d="M8 4h2v6H4V8h4V4zm6 0h2v4h4v2h-6V4zM4 14h6v6H8v-4H4v-2zm10 0h6v2h-4v4h-2v-6z" />,
);
export const IconGearSmall = svg(
  <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4c0-.6-.1-1.2-.2-1.7l2-1.5-2-3.5-2.3 1a8 8 0 0 0-3-1.7L15 2H9l-.5 2.6a8 8 0 0 0-3 1.7l-2.3-1-2 3.5 2 1.5a8.6 8.6 0 0 0 0 3.4l-2 1.5 2 3.5 2.3-1a8 8 0 0 0 3 1.7L9 22h6l.5-2.6a8 8 0 0 0 3-1.7l2.3 1 2-3.5-2-1.5c.1-.5.2-1.1.2-1.7z" />,
);
export const IconCaptions = svg(
  <path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3.5 5.5h3V9h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h4v-1.5h-3v-3zm8 0h3V9h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h4v-1.5h-3v-3z" />,
);
export const IconCheck = svg(<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" />);
export const IconChevronLeft = svg(<path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12l4.6-4.6z" />);
export const IconChevronRight = svg(<path d="m8.6 7.4 1.4-1.4 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6z" />);
export const IconChevronUp = svg(<path d="m12 8-6 6 1.4 1.4L12 10.8l4.6 4.6L18 14l-6-6z" />);
export const IconChevronDown = svg(<path d="m12 16 6-6-1.4-1.4L12 13.2 7.4 8.6 6 10l6 6z" />);
export const IconSun = svg(
  <path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-6 1.8 3.2h-3.6L12 1zm0 22-1.8-3.2h3.6L12 23zM1 12l3.2-1.8v3.6L1 12zm22 0-3.2 1.8v-3.6L23 12zM4.2 4.2l3.5.9-2.6 2.6-.9-3.5zm15.6 15.6-3.5-.9 2.6-2.6.9 3.5zM19.8 4.2l-.9 3.5-2.6-2.6 3.5-.9zM4.2 19.8l.9-3.5 2.6 2.6-3.5.9z" />,
);
export const IconMoon = svg(
  <path d="M12.7 2a9 9 0 1 0 9.3 12.3 7.5 7.5 0 0 1-9.3-12.3z" />,
);
export const IconLogout = svg(
  <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3zm6.2 3.6-1.4 1.4 2.5 2.5H8v2h9.3l-2.5 2.5 1.4 1.4L21 12l-4.8-5.4z" />,
);
export const IconRefresh = svg(
  <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" />,
);
export const IconEye = svg(
  <path d="M12 5C6.5 5 2.3 9.1 1 12c1.3 2.9 5.5 7 11 7s9.7-4.1 11-7c-1.3-2.9-5.5-7-11-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />,
);
export const IconEyeOff = svg(
  <path d="M2 4.3 3.3 3 21 20.7 19.7 22l-3.2-3.2A11 11 0 0 1 12 19C6.5 19 2.3 14.9 1 12a13 13 0 0 1 4.2-5L2 4.3zM12 7a5 5 0 0 1 4.6 7l-2-2a3 3 0 0 0-3.6-3.6l-2-2A5 5 0 0 1 12 7zm0-2c5.5 0 9.7 4.1 11 7a13.6 13.6 0 0 1-3 4l-1.5-1.5A11.6 11.6 0 0 0 20.8 12C19.4 9.8 16.2 7 12 7c-.5 0-.9 0-1.3.1L9.2 5.3C10.1 5.1 11 5 12 5z" />,
);
export const IconFilm = svg(
  <path d="M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 2v2h2V5H6zm10 0v2h2V5h-2zM6 9v6h12V9H6zm0 8v2h2v-2H6zm10 0v2h2v-2h-2z" />,
);
export const IconFolder = svg(
  <path d="M3 5h6l2 2h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />,
);
export const IconPip = svg(
  <path d="M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm9 8v5h8v-5h-8z" />,
);
export const IconForward = svg(
  <path d="M12 5V1l5 4-5 4V6a6 6 0 1 0 6 6h2a8 8 0 1 1-8-7z" />,
);
export const IconBack = svg(
  <path d="M12 5V1L7 5l5 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-7z" />,
);
export const IconWarning = svg(
  <path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z" />,
);
export const IconDataSaver = svg(
  <path d="M12 3a9 9 0 0 1 9 9h-2a7 7 0 0 0-7-7V3zm0 4a5 5 0 0 1 5 5h-2a3 3 0 0 0-3-3V7zM3.3 2 22 20.7 20.6 22 16 17.4A9 9 0 0 1 3 12a8.9 8.9 0 0 1 2.6-6.3L1.9 3.4 3.3 2zM7 7.1A7 7 0 0 0 14.5 16L7 7.1z" />,
);
export const IconPin = svg(
  <path d="M14 2 9.6 6.4 5 7.5l-1.4 1.4 5 5-5.6 5.6L4 21l5.6-5.6 5 5L16 19l1.1-4.6L21.5 10 14 2z" />,
);
export const IconYouTube = svg(
  <path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3L10 15z" />,
);
export const IconRepeat = svg(
  <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />,
);
export const IconShuffle = svg(
  <path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2 1.4-1.4zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4h-5.5zm.3 9.4-1.4 1.4 3.1 3.1-2 2.1H20v-5.5l-2 2-3.2-3.1z" />,
);
export const IconMore = svg(
  <path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />,
);
export const IconSkipNext = svg(<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />);
export const IconSkipPrevious = svg(<path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" />);
export const IconQueueAdd = svg(
  <path d="M3 5h12v2H3V5zm0 4h12v2H3V9zm0 4h8v2H3v-2zm14 0h2v3h3v2h-3v3h-2v-3h-3v-2h3v-3z" />,
);
export const IconQueue = svg(
  <path d="M3 5h12v2H3V5zm0 4h12v2H3V9zm0 4h8v2H3v-2zm13-1v7l6-3.5-6-3.5z" />,
);
export const IconMenu = svg(<path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />);
export const IconTheater = svg(
  <path d="M2 6h20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm1 2v8h18V8H3z" />,
);
export const IconSpeed = svg(
  <path d="M12 4a9 9 0 0 0-7.5 14l1.7-1.1A7 7 0 1 1 19 15.9l1.6 1.2A9 9 0 0 0 12 4zm1 4h-2v5h5v-2h-3V8z" />,
);
export const IconPlaylist = svg(
  <path d="M3 6h13v2H3V6zm0 4h13v2H3v-2zm0 4h9v2H3v-2zm14-4v6.2a3 3 0 1 0 2 2.8V12h3v-2h-5z" />,
);
export const IconPlaylistAdd = svg(
  <path d="M3 6h13v2H3V6zm0 4h13v2H3v-2zm0 4h9v2H3v-2zm15 0v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z" />,
);
export const IconLibrary = svg(
  <path d="M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />,
);
export const IconUsers = svg(
  <path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z" />,
);
export const IconShield = svg(
  <path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3zm-1.2 14.2L7 12.4l1.4-1.4 2.4 2.4 4.8-4.8L17 10l-6.2 6.2z" />,
);
export const IconTrash = svg(<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />);
export const IconEdit = svg(
  <path d="M3 17.2V21h3.8L17.8 9.9l-3.7-3.7L3 17.2zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z" />,
);
export const IconPlus = svg(<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />);
export const IconShare = svg(
  <path d="M18 16a3 3 0 0 0-2 .8L8.9 12.7a3 3 0 0 0 0-1.4L16 7.2A3 3 0 1 0 15 5c0 .2 0 .5.1.7L8 9.8a3 3 0 1 0 0 4.4l7.1 4.1a3 3 0 1 0 2.9-2.3z" />,
);
