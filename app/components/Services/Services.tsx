'use client'

import styles from './Services.module.css'
import { useFocusState, FocusModes } from '../Context/FocusStateContext'


export function Services() {

    const { focusMode } = useFocusState();

    if(focusMode !== FocusModes.Developer){
        return null;
    }

    return (
       <div
        style={{
          backgroundColor: "var(--primary-color)",
          color: "var(--secondary-color)",
          width: "100%",
          padding: "2rem",
        }}
      >
        <h2>Services</h2>
        <div
          style={{
            display: "flex",
            padding: "1rem",
            flexDirection: "column",
          }}
        >
          <div>
            <h3>Mobile Developement</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <img
                src="https://unsplash.com/photos/bMTl6uFMONg/download?ixid=M3wxMjA3fDB8MXxzZWFyY2h8Mnx8bW9iaWxlJTIwYXBwfGVufDB8fHx8MTcwOTIzNzUyNnww&force=true&w=640"
                style={{
                  width: "350px",
                  padding: "1rem",
                }}
                alt="tacos"
              />
              <p>
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. In
                commodo erat eleifend risus tempor, a gravida metus maximus.
                Praesent gravida diam vitae nisi aliquam, non scelerisque eros
                ullamcorper. Mauris vel porttitor ante, vel facilisis risus.
                Vestibulum eu magna sit amet felis bibendum dapibus eget et
                magna. Maecenas maximus lobortis lacus in fermentum. Nullam at
                ante tempor odio vulputate malesuada eget vitae elit. Mauris
                tempor consectetur nibh, quis dictum sapien fringilla eget.
              </p>
            </div>
          </div>
          <div>
            <h3>Web Developement</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "row-reverse",
                alignItems: "center",
              }}
            >
              <img
                src="https://unsplash.com/photos/hGV2TfOh0ns/download?ixid=M3wxMjA3fDB8MXxzZWFyY2h8OHx8d2Vic2l0ZXxlbnwwfHx8fDE3MDkyMjQyNzR8MA&force=true&w=640"
                style={{
                  width: "350px",
                  padding: "1rem",
                }}
              />
              <div>
                <p>
                  Lorem ipsum dolor sit amet, consectetur adipiscing elit. In
                  commodo erat eleifend risus tempor, a gravida metus maximus.
                  Praesent gravida diam vitae nisi aliquam, non scelerisque eros
                  ullamcorper. Mauris vel porttitor ante, vel facilisis risus.
                  Vestibulum eu magna sit amet felis bibendum dapibus eget et
                  magna. Maecenas maximus lobortis lacus in fermentum. Nullam at
                  ante tempor odio vulputate malesuada eget vitae elit. Mauris
                  tempor consectetur nibh, quis dictum sapien fringilla eget.
                </p>
                <button>Looking at web projects</button>
              </div>
            </div>
          </div>
          <div>
            <h3>IoT/Firmware Developement</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <img
                src="https://unsplash.com/photos/cDK_VY_A9x8/download?ixid=M3wxMjA3fDB8MXxzZWFyY2h8MTZ8fGlvdHxlbnwwfHx8fDE3MDkyMzg0MDh8MA&force=true&w=640"
                style={{
                  width: "350px",
                  padding: "1rem",
                }}
              />
              <p>
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. In
                commodo erat eleifend risus tempor, a gravida metus maximus.
                Praesent gravida diam vitae nisi aliquam, non scelerisque eros
                ullamcorper. Mauris vel porttitor ante, vel facilisis risus.
                Vestibulum eu magna sit amet felis bibendum dapibus eget et
                magna. Maecenas maximus lobortis lacus in fermentum. Nullam at
                ante tempor odio vulputate malesuada eget vitae elit. Mauris
                tempor consectetur nibh, quis dictum sapien fringilla eget.
              </p>
            </div>
          </div>
        </div>
      </div> 
    )
}