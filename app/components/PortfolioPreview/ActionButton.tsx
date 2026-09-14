'use client'
import { motion } from "framer-motion";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MotionLink = motion.create(Link);

export default function ActionButton({className, href, children}: any){

    return (
      <div
        style={{
          padding: "1rem",
          width: "100%",
          display: "flex",
        }}
      >
        <Button
          variant="outline"
          className={cn("text-white", className)}
          nativeButton={false}
          render={<MotionLink whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.9 }} href={href} />}
        >
          {children}
        </Button>
      </div>
    );
}