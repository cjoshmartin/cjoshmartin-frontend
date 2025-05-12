'use client'

import { useFocusState } from "../components/Context/FocusStateContext";
import { FocusModes } from "../components/Context/FocusMode";


function MeetupItem({
  title,
  description,
  link,
  memberCount,
  runningSince,
}: {
  title: string;
  description: string;
  link: string;
  memberCount: number;
  runningSince: string;
}) {
  return (
    <div>
      <h3>{title}</h3>
      <div
        style={{
          display: "flex",
          gap: "1rem",
        }}
      >
        <small>{memberCount} members</small>
        <small>Running since {runningSince}</small>
      </div>
      <p>{description}</p>

      <a href={link}>Check it out here</a>
    </div>
  );
}

export function Meetup() {

    const { focusMode } = useFocusState();

    const isDeveloper = focusMode === FocusModes.Developer;
    const isMaker = focusMode === FocusModes.Maker;

    return (
      <div
        style={{
          backgroundColor: "var(--primary-color)",
          color: "var(--secondary-color)",
          width: "100%",
          padding: "2rem",
        }}
      >
        <h2>Meetups</h2>

        {isMaker && (
          <MeetupItem
            title="3d Printing Meetup"
            description="Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
            link="https://www.meetup.com/chicago-3d-printing-meetup-group"
            memberCount={100}
            runningSince="2015"
          />
        )}
        {isDeveloper && (
          <>
            <MeetupItem
              title="Chicago React Native Meetup"
              description="Chicago React Native Meetup is a group of React Native developers who meet up to share their knowledge and experience."
              link="https://www.meetup.com/chicago-react-native-meetup"
              memberCount={100}
              runningSince="2015"
            />
            <MeetupItem
              title="Chicago Indie Hackers"
              description="Chicago Indie Hackers is a meetup for indie hackers to share their knowledge and experience."
              link="https://www.meetup.com/chicago-indie-hackers/"
              memberCount={50}
              runningSince="2015"
            />
          </>
        )}
      </div>
    );
}