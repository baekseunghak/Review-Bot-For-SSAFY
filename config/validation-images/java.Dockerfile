FROM eclipse-temurin:17-jdk-jammy
COPY gradle-seed /opt/gradle-seed
RUN chmod -R a+rX /opt/gradle-seed \
    && find /opt/gradle-seed/wrapper -type f -path '*/bin/gradle' -exec chmod a+x {} \;
